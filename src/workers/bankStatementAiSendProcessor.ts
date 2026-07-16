import { Worker, UnrecoverableError } from 'bullmq';
import { eq } from 'drizzle-orm';

import { db } from '../db/index.js';
import { bankStatementUploads, bankTransactions, processingErrors } from '../db/schema.js';
import { BankStatementAiSendJobData } from '../queue/index.js';
import { getAIService } from '../ai/index.js';
import { extractStatementPhase2 } from '../services/bank-statement/statement-extractor.js';
import { matchStatementUploadTransactions } from '../services/transaction-receipt-matcher.js';
import { createLogger } from '../utils/logger.js';
import { extractRateLimitError, isRateLimitError } from './stages/errors.js';
import {
  detectTransactionDuplicates,
  numericOrNull,
  resolveAccountByRedactedSuffixes,
  resolveBankAccount,
} from './bankStatementProcessor.js';
import { getConfig } from '../config/index.js';
import dotenv from 'dotenv';

dotenv.config();

const log = createLogger('worker.bankStatementAiSendProcessor');

const connection = {
  host: getConfig().REDIS_HOST,
  port: getConfig().REDIS_PORT,
};

/**
 * Phase 2 — sends pre-redacted, user-confirmed text to the AI provider.
 *
 * GDPR review gate, defense-in-depth checks. The job will REFUSE to call the
 * AI service unless ALL of the following hold:
 *   1. Upload row exists and is not soft-deleted.
 *   2. status === 'processing' (set by the confirm endpoint).
 *   3. userConfirmedAt IS NOT NULL (set by the confirm endpoint).
 *   4. redactedText IS NOT NULL.
 *
 * Any violation throws UnrecoverableError so BullMQ does not retry the job.
 * The error is surfaced via processing_errors so it is visible in the UI.
 *
 * As an extra safety net, the redacted text is run through redactPII a second
 * time inside parseStatementPdfWithAI before being sent to the model.
 */
const bankStatementAiSendWorker = new Worker<BankStatementAiSendJobData>(
  'bank-statement-ai-send',
  async (job) => {
    const { uploadId } = job.data;
    log.info({ jobId: job.id, uploadId }, 'phase 2: AI send job picked up');

    const [upload] = await db.select().from(bankStatementUploads).where(eq(bankStatementUploads.id, uploadId));

    // GATE 1 — existence + not deleted
    if (!upload) {
      throw new UnrecoverableError(`Bank statement upload ${uploadId} not found`);
    }
    if (upload.deletedAt) {
      log.info({ uploadId }, 'GATE: upload soft-deleted, refusing AI send');
      return;
    }

    // GATE 2 — status must be 'processing' (confirm endpoint flips from
    // pending_user_review to processing). Any other status means either the
    // user has not confirmed (pending_user_review) or the upload is in a
    // terminal state (completed/failed/duplicate) and re-running would be a
    // bug.
    if (upload.status !== 'processing') {
      log.error({ uploadId, status: upload.status }, 'CRITICAL GATE FAIL: phase 2 invoked while status != processing');
      await db.insert(processingErrors).values({
        uploadType: 'bank_statement',
        uploadId,
        category: 'SYSTEM_ERROR',
        message: `Phase 2 refused: status is '${upload.status}', expected 'processing'`,
        metadata: { errorType: 'REVIEW_GATE_VIOLATION', gate: 'status' },
      });
      throw new UnrecoverableError('phase 2 refused: bad status');
    }

    // GATE 3 — explicit user confirmation. This is the primary trust anchor.
    if (!upload.userConfirmedAt) {
      log.error({ uploadId }, 'CRITICAL GATE FAIL: phase 2 invoked without userConfirmedAt');
      await db.insert(processingErrors).values({
        uploadType: 'bank_statement',
        uploadId,
        category: 'SYSTEM_ERROR',
        message: 'Phase 2 refused: userConfirmedAt is NULL',
        metadata: { errorType: 'REVIEW_GATE_VIOLATION', gate: 'userConfirmedAt' },
      });
      // Force the upload back to pending_user_review so the user has a chance
      // to actually confirm. Don't leave it stuck in 'processing'.
      await db.update(bankStatementUploads)
        .set({ status: 'pending_user_review' })
        .where(eq(bankStatementUploads.id, uploadId));
      throw new UnrecoverableError('phase 2 refused: missing user confirmation');
    }

    // GATE 4 — redacted text must be present.
    if (!upload.redactedText) {
      log.error({ uploadId }, 'GATE FAIL: phase 2 invoked but redactedText is NULL');
      await db.insert(processingErrors).values({
        uploadType: 'bank_statement',
        uploadId,
        category: 'SYSTEM_ERROR',
        message: 'Phase 2 refused: redactedText is NULL (already cleared or never set)',
        metadata: { errorType: 'REVIEW_GATE_VIOLATION', gate: 'redactedText' },
      });
      await db.update(bankStatementUploads)
        .set({ status: 'failed' })
        .where(eq(bankStatementUploads.id, uploadId));
      throw new UnrecoverableError('phase 2 refused: missing redacted text');
    }

    log.info({ uploadId, confirmedAt: upload.userConfirmedAt, fromIp: upload.userConfirmedFromIp }, 'all gates passed, calling AI');

    const startedAt = Date.now();

    try {
      const aiService = getAIService();
      // extractStatementPhase2 → parseStatementPdfWithAI → re-runs redactPII
      // over the input as a defense-in-depth (should be no-op on already-
      // redacted text, but the redactor catches anything that slipped through).
      const parsed = await extractStatementPhase2({
        redactedText: upload.redactedText,
        primaryIban: upload.detectedIban ?? undefined,
        aiService,
      });
      await job.updateProgress(60);

      let bankAccountId: number | null = upload.bankAccountId ?? null;
      if (!bankAccountId) {
        bankAccountId = await resolveBankAccount(upload.userId, parsed.account.iban, parsed.account.bankName);
      }
      // Suffix-based fallback: if neither our local IBAN regex nor the AI
      // surfaced a usable IBAN, try matching the last 6 chars of any redacted
      // IBAN against the user's already-saved accounts.
      if (!bankAccountId && upload.redactedText) {
        bankAccountId = await resolveAccountByRedactedSuffixes(upload.userId, upload.redactedText);
      }

      if (!bankAccountId) {
        // Keep redactedText so edit.ts can re-enqueue directly to Phase 2
        // when the user picks an account, avoiding a second review-gate round.
        await db.update(bankStatementUploads)
          .set({
            status: 'needs_account_selection',
            parsingMetadata: {
              parser: parsed.parser,
              parserVersion: parsed.parserVersion,
              detectedIban: parsed.account.iban,
              detectedBankName: parsed.account.bankName,
              transactionCount: parsed.transactions.length,
              warnings: parsed.warnings,
              processedAt: new Date().toISOString(),
              durationMs: Date.now() - startedAt,
            },
          })
          .where(eq(bankStatementUploads.id, uploadId));
        log.info({ uploadId }, 'no IBAN matched after AI extraction, asking user to pick account');
        await job.updateProgress(100);
        return;
      }

      // Zero-transaction guard: if the AI returned nothing usable (over-redacted
      // text, all-rows-bad-date, notAStatement=true, or model gave up), do NOT
      // silently mark the upload completed. Flip to failed and surface the AI
      // warnings so the user can see why. Keep redactedText so they can retry.
      if (parsed.transactions.length === 0) {
        log.warn({ uploadId, warnings: parsed.warnings }, 'phase 2: AI returned zero transactions');
        await db.insert(processingErrors).values({
          uploadType: 'bank_statement',
          uploadId,
          category: 'EXTRACTION_FAILURE',
          message: parsed.warnings.length
            ? `AI ni vrnil nobene transakcije. Opozorila: ${parsed.warnings.map((w) => w.code).join(', ')}`
            : 'AI ni vrnil nobene transakcije in nobenih opozoril — preveri kakovost PDF besedila.',
          metadata: {
            errorType: 'ZERO_TRANSACTIONS',
            warnings: parsed.warnings,
            redactedTextLength: upload.redactedText.length,
          },
        });
        await db.update(bankStatementUploads)
          .set({
            status: 'failed',
            parsingMetadata: {
              parser: parsed.parser,
              parserVersion: parsed.parserVersion,
              detectedIban: parsed.account.iban,
              detectedBankName: parsed.account.bankName,
              transactionCount: 0,
              warnings: parsed.warnings,
              processedAt: new Date().toISOString(),
              durationMs: Date.now() - startedAt,
            },
          })
          .where(eq(bankStatementUploads.id, uploadId));
        await job.updateProgress(100);
        return;
      }

      await db.update(bankStatementUploads)
        .set({
          bankAccountId,
          periodStart: parsed.period.periodStart ?? null,
          periodEnd: parsed.period.periodEnd ?? null,
          openingBalance: numericOrNull(parsed.period.openingBalance),
          closingBalance: numericOrNull(parsed.period.closingBalance),
          totalDebit: numericOrNull(parsed.period.totalDebit),
          totalCredit: numericOrNull(parsed.period.totalCredit),
          parsingMetadata: {
            parser: parsed.parser,
            parserVersion: parsed.parserVersion,
            detectedIban: parsed.account.iban,
            detectedBankName: parsed.account.bankName,
            transactionCount: parsed.transactions.length,
            warnings: parsed.warnings,
            processedAt: new Date().toISOString(),
            durationMs: Date.now() - startedAt,
          },
        })
        .where(eq(bankStatementUploads.id, uploadId));

      const rows = parsed.transactions.map((t) => ({
        statementUploadId: uploadId,
        bankAccountId: bankAccountId!,
        userId: upload.userId,
        transactionDate: t.transactionDate,
        valueDate: t.valueDate ?? null,
        description: t.description ?? null,
        debit: numericOrNull(t.debit),
        credit: numericOrNull(t.credit),
        runningBalance: numericOrNull(t.runningBalance),
        currency: t.currency,
        confidenceScores: t.confidenceScores,
      }));

      if (rows.length) {
        const chunkSize = 500;
        for (let i = 0; i < rows.length; i += chunkSize) {
          await db.insert(bankTransactions).values(rows.slice(i, i + chunkSize));
        }
      }
      await job.updateProgress(80);

      await detectTransactionDuplicates(upload.userId, bankAccountId, uploadId);

      try {
        await matchStatementUploadTransactions(uploadId);
      } catch (err) {
        log.warn({ err, uploadId }, 'transaction-receipt matching failed, upload still completed');
      }

      const finalStatus: 'completed' | 'partly_completed' = parsed.warnings.length ? 'partly_completed' : 'completed';

      // CRITICAL: clear redactedText after successful processing. We do not
      // keep the full statement text around as audit data — the persisted
      // transactions (with their already-redacted descriptions) plus
      // userConfirmedAt are sufficient.
      await db.update(bankStatementUploads)
        .set({
          status: finalStatus,
          redactedText: null,
          pendingReviewExpiresAt: null,
        })
        .where(eq(bankStatementUploads.id, uploadId));
      await job.updateProgress(100);

      log.info({ uploadId, transactionCount: rows.length, status: finalStatus }, 'phase 2 completed');
    } catch (err) {
      const rateLimit = extractRateLimitError(err);
      if (rateLimit) {
        log.warn({ uploadId, err: String(err) }, 'AI rate limit during phase 2');
        // Roll back to pending_user_review so the user can retry once the
        // provider quota resets. The redactedText stays in place for retry.
        await db.update(bankStatementUploads)
          .set({ status: 'pending_user_review' })
          .where(eq(bankStatementUploads.id, uploadId));
        await db.insert(processingErrors).values({
          uploadType: 'bank_statement',
          uploadId,
          category: 'SYSTEM_ERROR',
          message: 'AI rate limit exceeded during phase 2',
          metadata: {
            errorType: 'RATE_LIMITED',
            resetTime: rateLimit.resetTime?.toISOString?.(),
            provider: rateLimit.provider,
          },
        });
        throw new UnrecoverableError('AI rate limit exceeded');
      }

      log.error({ uploadId, err }, 'phase 2 failed');
      await db.update(bankStatementUploads)
        .set({ status: 'failed' })
        .where(eq(bankStatementUploads.id, uploadId));
      await db.insert(processingErrors).values({
        uploadType: 'bank_statement',
        uploadId,
        category: 'EXTRACTION_FAILURE',
        message: err instanceof Error ? err.message : String(err),
        metadata: { errorType: 'BANK_STATEMENT_AI_SEND_FAILED' },
      });
      if (isRateLimitError(err)) {
        throw new UnrecoverableError('AI rate limit exceeded');
      }
      throw err;
    }
  },
  { connection, concurrency: 1 },
);

export default bankStatementAiSendWorker;

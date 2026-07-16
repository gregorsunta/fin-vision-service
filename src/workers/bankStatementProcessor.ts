import { Worker, UnrecoverableError } from 'bullmq';
import fs from 'fs/promises';
import { and, eq, isNull } from 'drizzle-orm';

import { db } from '../db/index.js';
import {
  bankAccounts,
  bankStatementUploads,
  bankTransactions,
  processingErrors,
} from '../db/schema.js';
import { BankStatementJobData } from '../queue/index.js';
import { extractStatementPhase1 } from '../services/bank-statement/statement-extractor.js';
import {
  detectBankName,
  extractRedactedIbanSuffixes,
  validateIban,
} from '../services/bank-statement/iban-utils.js';
import { matchStatementUploadTransactions } from '../services/transaction-receipt-matcher.js';
import { createLogger } from '../utils/logger.js';
import { resolveImagePath } from './stages/path.js';
import { getConfig } from '../config/index.js';
import dotenv from 'dotenv';

// 30-day TTL on pending_user_review uploads. Configurable via env if needed.
const REVIEW_TTL_MS = 30 * 24 * 60 * 60 * 1000;

dotenv.config();

const log = createLogger('worker.bankStatementProcessor');

const connection = {
  host: getConfig().REDIS_HOST,
  port: getConfig().REDIS_PORT,
};

/**
 * Fallback account matcher when full-IBAN detection fails. Looks up bank
 * accounts owned by the user whose IBAN ends with the given 6-char suffix.
 * Returns the account only when exactly one match exists — multiple matches
 * are ambiguous and we'd rather ask the user than guess wrong.
 */
export async function findAccountByIbanSuffix(userId: number, suffix: string): Promise<number | null> {
  if (!suffix || suffix.length < 4) return null;
  const accounts = await db
    .select({ id: bankAccounts.id, iban: bankAccounts.iban })
    .from(bankAccounts)
    .where(and(eq(bankAccounts.userId, userId), isNull(bankAccounts.deletedAt)));
  const matches = accounts.filter((a) => a.iban.toUpperCase().endsWith(suffix.toUpperCase()));
  return matches.length === 1 ? matches[0].id : null;
}

/**
 * Tries every IBAN suffix found in redacted text against the user's saved
 * accounts. Stops at the first unambiguous match. Used by both Phase 1 (set
 * bankAccountId before review-gate) and Phase 2 (set bankAccountId after AI
 * if it didn't surface a usable IBAN).
 */
export async function resolveAccountByRedactedSuffixes(userId: number, redactedText: string): Promise<number | null> {
  const suffixes = extractRedactedIbanSuffixes(redactedText);
  for (const suffix of suffixes) {
    const id = await findAccountByIbanSuffix(userId, suffix);
    if (id) {
      log.info({ userId, suffix, accountId: id }, 'matched bank account via IBAN suffix fallback');
      return id;
    }
  }
  return null;
}

export async function resolveBankAccount(userId: number, iban: string | undefined, detectedBankName: string | undefined): Promise<number | null> {
  if (!iban) return null;
  const normalized = validateIban(iban);
  if (!normalized) return null;

  // Include soft-deleted rows in the lookup — the unique constraint on
  // (user_id, iban) applies to ALL rows, so a soft-deleted account would block
  // a fresh insert and produce a duplicate-key error.
  const [existing] = await db
    .select({ id: bankAccounts.id, deletedAt: bankAccounts.deletedAt })
    .from(bankAccounts)
    .where(and(
      eq(bankAccounts.userId, userId),
      eq(bankAccounts.iban, normalized.iban),
    ));

  if (existing) {
    if (existing.deletedAt) {
      log.warn({ userId, iban: normalized.iban, accountId: existing.id }, 'reusing soft-deleted bank account row');
    }
    return existing.id;
  }

  const bankName = detectedBankName ?? detectBankName(normalized.iban);
  const [inserted] = await db.insert(bankAccounts).values({
    userId,
    iban: normalized.iban,
    bankName,
    isAutoCreated: true,
    currency: 'EUR',
  }).$returningId();
  log.info({ userId, iban: normalized.iban, bankName, newAccountId: inserted.id }, 'auto-created bank account');
  return inserted.id;
}

export function numericOrNull(v: number | undefined): string | null {
  if (v == null || Number.isNaN(v)) return null;
  return v.toFixed(4);
}

const bankStatementProcessorWorker = new Worker<BankStatementJobData>(
  'bank-statement-processing',
  async (job) => {
    const { uploadId, filePath, mimeType, originalFileName } = job.data;
    log.info({ jobId: job.id, uploadId, mimeType }, 'processing bank statement');

    const [upload] = await db.select().from(bankStatementUploads).where(eq(bankStatementUploads.id, uploadId));
    if (!upload) {
      throw new UnrecoverableError(`Bank statement upload ${uploadId} not found`);
    }
    if (upload.deletedAt) {
      log.info({ uploadId }, 'upload soft-deleted, skipping');
      return;
    }
    if (upload.status === 'duplicate') {
      log.info({ uploadId }, 'already marked duplicate, skipping');
      return;
    }

    const startedAt = Date.now();

    try {
      const fullPath = resolveImagePath(filePath);
      const buffer = await fs.readFile(fullPath);
      await job.updateProgress(10);

      // Phase 1: parse locally only. NEVER calls an external API. For native
      // PDFs this returns redacted text, NOT the parsed transactions — those
      // come from Phase 2 after explicit user confirmation.
      const phase1 = await extractStatementPhase1({ buffer, mimeType, fileName: originalFileName });
      await job.updateProgress(40);

      if (phase1.kind === 'pending_review') {
        // Native PDF flow — we have redacted text only. Persist it and stop.
        // The user reviews the redacted text in the UI and explicitly confirms
        // before Phase 2 sends it to the AI. See workers/bankStatementAiSendProcessor.ts.

        // Pre-resolve the bank account: if local IBAN detection succeeded use
        // it directly; otherwise try suffix-matching the last 6 chars of any
        // redacted IBAN against the user's already-saved accounts. This lets
        // us skip needs_account_selection in the common case where the user
        // has the matching account but our regex couldn't validate the full
        // IBAN (weird formatting, missing checksum, etc.).
        let resolvedAccountId: number | null = upload.bankAccountId ?? null;
        if (!resolvedAccountId && phase1.primaryIban) {
          resolvedAccountId = await resolveBankAccount(upload.userId, phase1.primaryIban, undefined);
        }
        if (!resolvedAccountId) {
          resolvedAccountId = await resolveAccountByRedactedSuffixes(upload.userId, phase1.redactedText);
        }

        await db.update(bankStatementUploads)
          .set({
            status: 'pending_user_review',
            bankAccountId: resolvedAccountId,
            redactedText: phase1.redactedText,
            redactionStats: phase1.redactionStats,
            detectedIban: phase1.primaryIban ?? null,
            pendingReviewExpiresAt: new Date(Date.now() + REVIEW_TTL_MS),
            parsingMetadata: {
              parser: 'native-pdf',
              parserVersion: '1',
              detectedIban: phase1.primaryIban,
              transactionCount: 0,
              warnings: [],
              processedAt: new Date().toISOString(),
              durationMs: Date.now() - startedAt,
            },
          })
          .where(eq(bankStatementUploads.id, uploadId));
        await job.updateProgress(100);
        log.info({ uploadId, primaryIban: phase1.primaryIban, redactionStats: phase1.redactionStats }, 'phase 1 done, waiting for user review');
        return;
      }

      // CSV / XLSX path: no AI involved, finalize directly.
      const parsed = phase1.parsed;
      await job.updateProgress(50);

      // Account resolution: auto-link if IBAN recognized, auto-create if first
      // sighting for this user. Status falls back to needs_account_selection
      // when no IBAN could be parsed from the statement at all.
      let bankAccountId: number | null = upload.bankAccountId ?? null;
      if (!bankAccountId) {
        bankAccountId = await resolveBankAccount(upload.userId, parsed.account.iban, parsed.account.bankName);
      }

      if (!bankAccountId) {
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
        log.info({ uploadId }, 'no IBAN detected, waiting for user to pick account');
        await job.updateProgress(100);
        return;
      }

      // Zero-transaction guard: parsing returned an empty list. Don't silently
      // mark the upload completed — the user would see a "no transactions"
      // panel with no error. Flip to failed and surface what the parser saw.
      if (parsed.transactions.length === 0) {
        log.warn({ uploadId, parser: parsed.parser, warnings: parsed.warnings }, 'parser returned zero transactions');
        await db.insert(processingErrors).values({
          uploadType: 'bank_statement',
          uploadId,
          category: 'EXTRACTION_FAILURE',
          message: parsed.warnings.length
            ? `Parser ni vrnil nobene transakcije. Opozorila: ${parsed.warnings.map((w) => w.code).join(', ')}`
            : `Parser ${parsed.parser} ni vrnil nobene transakcije — preveri obliko datoteke.`,
          metadata: { errorType: 'ZERO_TRANSACTIONS', parser: parsed.parser, warnings: parsed.warnings },
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

      // Persist header updates before inserting transactions so any partial
      // failure still leaves useful metadata on the upload row.
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

      // Batch insert transactions. We persist only the GDPR-whitelisted set:
      // transaction_date, value_date, debit/credit, running_balance, currency,
      // (PII-redacted) description. Counterparty name/IBAN and reference are
      // intentionally absent from the schema — see migration 0027.
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
        // MySQL has a ~65k-row packet limit; chunk to stay safe on very long statements.
        const chunkSize = 500;
        for (let i = 0; i < rows.length; i += chunkSize) {
          await db.insert(bankTransactions).values(rows.slice(i, i + chunkSize));
        }
      }
      await job.updateProgress(70);

      await detectTransactionDuplicates(upload.userId, bankAccountId, uploadId);
      await job.updateProgress(85);

      try {
        await matchStatementUploadTransactions(uploadId);
      } catch (err) {
        log.warn({ err, uploadId }, 'transaction-receipt matching failed, upload still completed');
      }

      const finalStatus: 'completed' | 'partly_completed' = parsed.warnings.length ? 'partly_completed' : 'completed';
      await db.update(bankStatementUploads)
        .set({ status: finalStatus })
        .where(eq(bankStatementUploads.id, uploadId));
      await job.updateProgress(100);

      log.info({ uploadId, transactionCount: rows.length, status: finalStatus }, 'bank statement processed');
    } catch (err) {
      log.error({ uploadId, err }, 'bank statement processing failed');
      await db.update(bankStatementUploads)
        .set({ status: 'failed' })
        .where(eq(bankStatementUploads.id, uploadId));
      await db.insert(processingErrors).values({
        uploadType: 'bank_statement',
        uploadId,
        category: 'EXTRACTION_FAILURE',
        message: err instanceof Error ? err.message : String(err),
        metadata: { errorType: 'BANK_STATEMENT_PARSE_FAILED' },
      });
      throw err;
    }
  },
  { connection, concurrency: 1 },
);

/**
 * Marks transactions inserted for a given upload as duplicates of earlier
 * transactions on the same bank_account, based on (date, debit, credit,
 * normalized description). Conservative heuristic — only flags exact matches.
 */
export async function detectTransactionDuplicates(userId: number, bankAccountId: number, uploadId: number): Promise<void> {
  const newRows = await db.select().from(bankTransactions)
    .where(and(
      eq(bankTransactions.statementUploadId, uploadId),
      isNull(bankTransactions.deletedAt),
    ));
  const existing = await db.select().from(bankTransactions)
    .where(and(
      eq(bankTransactions.userId, userId),
      eq(bankTransactions.bankAccountId, bankAccountId),
      isNull(bankTransactions.deletedAt),
    ));

  // Build a lookup of existing rows EXCLUDING the ones we just inserted so a
  // duplicate within the same statement flags the later row, not the earlier.
  const uploadRowIds = new Set(newRows.map((r) => r.id));
  const priorRows = existing.filter((r) => !uploadRowIds.has(r.id));

  const keyOf = (r: typeof newRows[number]) => [
    r.transactionDate ? r.transactionDate.toISOString().slice(0, 10) : '',
    r.debit ?? '',
    r.credit ?? '',
    // Description is already PII-redacted, so the key is naturally normalized
    // around generic tokens like [NAME]/[IBAN].
    (r.description ?? '').toLowerCase().replace(/\s+/g, ' ').trim(),
  ].join('|');

  const index = new Map<string, number>();
  for (const r of priorRows) index.set(keyOf(r), r.id);

  for (const r of newRows) {
    const match = index.get(keyOf(r));
    if (match && match !== r.id) {
      await db.update(bankTransactions)
        .set({
          isDuplicate: true,
          duplicateOfTransactionId: match,
          duplicateConfidenceScore: '100.00',
        })
        .where(eq(bankTransactions.id, r.id));
    }
  }
}

export default bankStatementProcessorWorker;

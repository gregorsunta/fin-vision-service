import type { AIService } from '../../ai/index.js';
import { createLogger } from '../../utils/logger.js';
import { parseStatementCsv } from './csv-parser.js';
import { parseStatementXlsx } from './xlsx-parser.js';
import { extractNativePdf } from './pdf-native-parser.js';
import { parseStatementPdfWithAI } from './pdf-ai-parser.js';
import { redactPIIWithNLP, type RedactionResult } from './pii-filter.js';
import { findIbanInText } from './iban-utils.js';
import { tryLocalParse } from './local-parsers/registry.js';
import type { ParsedStatement } from './types.js';

const log = createLogger('services.bank-statement.extractor');

export interface StatementExtractInput {
  buffer: Buffer;
  mimeType: string;
  fileName?: string;
  aiService: AIService;
}

export type StatementPhase1Result =
  // CSV / XLSX: parsing finishes locally, no external API needed.
  | { kind: 'parsed'; parsed: ParsedStatement }
  // Native PDF: text extracted + redacted locally. The user must explicitly
  // confirm before the redacted text is sent to the AI provider in Phase 2.
  | {
      kind: 'pending_review';
      redactedText: string;
      redactionStats: RedactionResult['replacements'];
      primaryIban?: string;
      pageCount: number;
    };

export interface StatementPhase1Input {
  buffer: Buffer;
  mimeType: string;
  fileName?: string;
}

/**
 * Phase 1: parse locally. NEVER calls an external API.
 *
 * - CSV / XLSX: full parsing, returns ParsedStatement directly. No AI call needed.
 * - Native PDF: extracts text locally with `pdf-parse`, redacts PII, returns the
 *   redacted text. The AI call is deferred to Phase 2, gated on explicit user
 *   confirmation. No raw PDF buffer ever leaves this process.
 * - Scanned PDF: throws — would require external OCR which we refuse.
 */
export async function extractStatementPhase1(input: StatementPhase1Input): Promise<StatementPhase1Result> {
  const { buffer, mimeType, fileName } = input;
  log.info({ mimeType, fileName, size: buffer.length }, 'phase 1: parsing statement');

  const lowerName = (fileName ?? '').toLowerCase();
  const isCsv = mimeType === 'text/csv' || mimeType === 'application/csv' || lowerName.endsWith('.csv');
  const isXlsx =
    mimeType === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' ||
    mimeType === 'application/vnd.ms-excel' ||
    lowerName.endsWith('.xlsx') ||
    lowerName.endsWith('.xls');
  const isPdf = mimeType === 'application/pdf' || lowerName.endsWith('.pdf');

  if (isCsv) {
    return { kind: 'parsed', parsed: await parseStatementCsv({ buffer }) };
  }
  if (isXlsx) {
    return { kind: 'parsed', parsed: await parseStatementXlsx(buffer) };
  }
  if (isPdf) {
    const native = await extractNativePdf(buffer);
    if (!native.hasTextLayer) {
      throw new Error(
        'Skenirani PDF (brez text layer-ja) trenutno ni podprt. Naloži CSV/XLSX ali native PDF s tekstom. ' +
          'Razlog: za GDPR ne pošiljamo skeniranih dokumentov v tretje strani; lokalni OCR še ni omogočen.',
      );
    }
    // Redact once, up front, regardless of which path handles the statement
    // next. Isolated per-field redaction (tried and reverted — see
    // local-parsers/types.ts) is less reliable than whole-document redaction:
    // a short extracted fragment gives the NER model no sentence context to
    // calibrate on. Detect IBAN BEFORE redaction so the user's own account
    // stays visible; every other IBAN gets stripped.
    const primaryIban = findIbanInText(native.text) ?? native.info?.account.iban ?? undefined;
    const { text: redactedText, replacements } = await redactPIIWithNLP(native.text, { primaryIban });

    // Try a local (no external AI, no external send) parser for known bank
    // formats against the now-safe text. These adapters additionally drop
    // the counterparty field structurally rather than relying on redaction
    // alone. No pending user-confirmation gate needed for a recognised
    // format — nothing is ever sent externally, so there's nothing to confirm.
    const local = tryLocalParse(redactedText);
    if (local) {
      log.info({ parser: local.parser, transactions: local.transactions.length }, 'phase 1: parsed locally, no AI needed');
      return { kind: 'parsed', parsed: local };
    }

    // Unknown format — fall back to the AI-assisted flow, which requires
    // explicit user confirmation before anything reaches the AI provider
    // (Phase 2). Text is already redacted above.
    log.info({ replacements, primaryIban, pageCount: native.pageCount }, 'phase 1: redacted, ready for user review');
    return {
      kind: 'pending_review',
      redactedText,
      redactionStats: replacements,
      primaryIban,
      pageCount: native.pageCount,
    };
  }

  throw new Error(`Unsupported statement mime type: ${mimeType} (${fileName ?? 'unnamed'})`);
}

/**
 * Phase 2: send pre-redacted text to the AI provider.
 *
 * Caller MUST verify the user has explicitly confirmed (via DB gate) before
 * invoking this. As an additional safety net, parseStatementPdfWithAI re-runs
 * redactPII over the input even though it should already be redacted.
 */
export async function extractStatementPhase2(input: {
  redactedText: string;
  primaryIban?: string;
  aiService: AIService;
}): Promise<ParsedStatement> {
  const { redactedText, primaryIban, aiService } = input;
  log.info({ primaryIban, textLength: redactedText.length }, 'phase 2: sending redacted text to AI');
  const aiResult = await parseStatementPdfWithAI({ text: redactedText, aiService });
  if (!aiResult.account.iban && primaryIban) {
    aiResult.account.iban = primaryIban;
  }
  return aiResult;
}

export { parseStatementCsv, parseStatementXlsx, extractNativePdf, parseStatementPdfWithAI };

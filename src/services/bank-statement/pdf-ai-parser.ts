import type { AIService } from '../../ai/index.js';
import { createLogger } from '../../utils/logger.js';
import { statementExtractionSchema, type StatementExtractionResult } from '../ai-extraction/statement-schema.js';
import { findIbanInText, detectBankName, validateIban } from './iban-utils.js';
import { redactPII } from './pii-filter.js';
import type { ParsedStatement, ParsedTransaction, ParsingWarning } from './types.js';

const log = createLogger('services.bank-statement.pdf-ai-parser');

const SYSTEM_PROMPT = `You extract structured bank statement data from REDACTED text.

The input is plain text from a bank statement that has been pre-processed
locally with positional reconstruction — items on the same physical row of the
PDF are on the same line, columns are separated by multiple spaces. Treat each
input line as ONE transaction row whenever it contains a date AND an amount.
Do NOT cross row boundaries: a debit/credit value belongs to the same line as
its date and description. If you are unsure which amount belongs to which row,
set the row's confidence low rather than guessing across lines.

Personal data has already been replaced with tokens like [OSEBA] (person name),
[EMAIL], [PHONE], [IBAN…suffix] (counterparty IBAN), [ADDR], [TAXID].
The user's own account IBAN may appear unredacted — that is intentional.
Merchant and company names are NOT redacted and appear as-is.

Rules:
1. Output strictly matches the provided JSON schema.
2. Dates MUST be ISO YYYY-MM-DD. Slovenian / European statements use DD.MM.YYYY (e.g. "03.04.2026" → "2026-04-03").
3. Number format is European: thousands separator is "." and decimal separator is ",". So "1.234,56" means one thousand two hundred thirty-four and fifty-six hundredths → 1234.56. NEVER read "1.234,56" as 1.23456.
4. "1.234" with no comma is one thousand two hundred thirty-four (1234), not 1.234. Only treat "." as a decimal point if there's no comma anywhere in the same number AND the digits after are exactly 2.
5. Debit column: money leaving the account, always positive. Credit column: money entering, always positive. Never negative.
6. If a single "amount" column is shown with +/- signs, set debit=|amount| for negatives and credit=amount for positives.
7. The runningBalance column changes between rows; the debit/credit on a row is the difference, NOT the running balance. Never copy the running balance into debit or credit.
8. Never invent or "fill in" redacted tokens — pass them through verbatim in the description field.
9. Description: copy the row text including any [NAME]/[ORG]/[IBAN] tokens. Do not output names or IBANs that aren't already in the input.
10. READ values directly. Do NOT compute totals or balances unless the statement shows them.
11. If the input clearly is not a bank statement, set notAStatement=true and return transactions=[].`;

const USER_PROMPT = `Extract every transaction row from this bank statement.

For each row provide:
- transactionDate (required)
- valueDate if shown and different
- description (the row text from the statement — leave any redaction tokens intact)
- debit OR credit (never both, never negative)
- runningBalance if the statement shows it on this row

Also return the account header: IBAN (only if it's the primary account, NOT a counterparty), bank name, statement period, opening and closing balance.

INPUT:
`;

function parseIsoDate(value: string | undefined): Date | null {
  if (!value) return null;
  const m = value.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return null;
  const date = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return isNaN(date.getTime()) ? null : date;
}

function stripCodeFences(text: string): string {
  let cleaned = text.trim();
  cleaned = cleaned.replace(/^```(?:json)?\n?/gm, '');
  cleaned = cleaned.replace(/\n?```$/gm, '');
  return cleaned.trim();
}

export interface PdfAiParseInput {
  /**
   * Plain-text content of the PDF. Caller is responsible for extracting
   * this locally (pdf-parse for native PDFs, Tesseract for scanned ones).
   * No raw PDF buffers ever leave this process.
   */
  text: string;
  aiService: AIService;
}

export async function parseStatementPdfWithAI(input: PdfAiParseInput): Promise<ParsedStatement> {
  const { text, aiService } = input;

  // Identify the user's own IBAN BEFORE redaction so we can preserve it.
  // Every other IBAN gets stripped — those are counterparty accounts.
  const primaryIban = findIbanInText(text) ?? undefined;

  const { text: redacted, replacements } = redactPII(text, { primaryIban });
  log.info({ pii: replacements, primaryIban }, 'redacted statement text before AI call');

  const result = await aiService.generate({
    prompt: USER_PROMPT + redacted,
    systemPrompt: SYSTEM_PROMPT,
    requireVision: false,
    responseFormat: 'json',
    responseSchema: statementExtractionSchema,
    config: { temperature: 0, maxTokens: 8192 },
  });

  let raw: StatementExtractionResult;
  try {
    raw = JSON.parse(stripCodeFences(result.text));
  } catch (err) {
    log.warn({ err, preview: result.text.slice(0, 500) }, 'AI response was not valid JSON');
    throw new Error('AI returned non-JSON response for statement extraction');
  }

  const warnings: ParsingWarning[] = (raw.warnings ?? []).map((w) => ({ code: w.code, message: w.message }));

  if (raw.notAStatement) {
    warnings.push({ code: 'not_a_statement', message: 'AI flagged document as not a bank statement' });
  }

  const transactions: ParsedTransaction[] = [];
  raw.transactions.forEach((t, idx) => {
    const date = parseIsoDate(t.transactionDate);
    if (!date) {
      warnings.push({ code: 'ai_row_bad_date', message: `row ${idx}: invalid date ${t.transactionDate}`, row: idx });
      return;
    }
    // Defense-in-depth: re-run redaction over the AI's description in case
    // the model leaked any value. AI also gets the redacted input, so this
    // is mostly a safety net.
    const safeDescription = t.description ? redactPII(t.description, { primaryIban }).text : undefined;

    transactions.push({
      transactionDate: date,
      valueDate: parseIsoDate(t.valueDate ?? undefined) ?? undefined,
      description: safeDescription,
      debit: typeof t.debit === 'number' ? Math.abs(t.debit) : undefined,
      credit: typeof t.credit === 'number' ? Math.abs(t.credit) : undefined,
      runningBalance: typeof t.runningBalance === 'number' ? t.runningBalance : undefined,
      currency: raw.currency ?? 'EUR',
      confidenceScores: {
        date: 0.9,
        amount: 0.85,
        description: t.description ? 0.8 : 0.0,
      },
    });
  });

  // Validate IBAN from AI: must round-trip the mod-97 checksum AND match the
  // primary IBAN we detected locally. Anything else gets dropped.
  const aiIbanCandidate = raw.iban && validateIban(raw.iban) ? raw.iban.replace(/\s+/g, '').toUpperCase() : undefined;
  const iban = aiIbanCandidate && primaryIban && aiIbanCandidate === primaryIban ? aiIbanCandidate : primaryIban;
  if (aiIbanCandidate && primaryIban && aiIbanCandidate !== primaryIban) {
    warnings.push({ code: 'iban_mismatch', message: 'AI IBAN differs from PDF text IBAN — using local detection' });
  }
  const bankName = iban ? detectBankName(iban) ?? raw.bankName ?? undefined : raw.bankName ?? undefined;

  // Reconciliation: if the statement reports totals or opening/closing balances,
  // compare against the sum of extracted rows. A mismatch usually means the AI
  // misread amounts (column shift, decimal-comma confusion, swapped debit/credit).
  // Tolerance is 1 cent per 1000€ + 1 cent floor — generous enough for rounding,
  // tight enough to catch real misreads.
  const sumDebit = transactions.reduce((s, t) => s + (t.debit ?? 0), 0);
  const sumCredit = transactions.reduce((s, t) => s + (t.credit ?? 0), 0);
  const reconcileTolerance = (value: number) => Math.max(0.01, Math.abs(value) * 0.001);
  if (typeof raw.totalDebit === 'number' && Math.abs(sumDebit - raw.totalDebit) > reconcileTolerance(raw.totalDebit)) {
    warnings.push({
      code: 'total_debit_mismatch',
      message: `Sum of debits ${sumDebit.toFixed(2)} ≠ stated total ${raw.totalDebit.toFixed(2)} — values may be misread`,
    });
  }
  if (typeof raw.totalCredit === 'number' && Math.abs(sumCredit - raw.totalCredit) > reconcileTolerance(raw.totalCredit)) {
    warnings.push({
      code: 'total_credit_mismatch',
      message: `Sum of credits ${sumCredit.toFixed(2)} ≠ stated total ${raw.totalCredit.toFixed(2)} — values may be misread`,
    });
  }
  if (typeof raw.openingBalance === 'number' && typeof raw.closingBalance === 'number') {
    const expectedDelta = raw.closingBalance - raw.openingBalance;
    const actualDelta = sumCredit - sumDebit;
    if (Math.abs(expectedDelta - actualDelta) > reconcileTolerance(Math.max(Math.abs(raw.openingBalance), Math.abs(raw.closingBalance)))) {
      warnings.push({
        code: 'balance_delta_mismatch',
        message: `Opening→closing delta ${expectedDelta.toFixed(2)} ≠ sum(credit-debit) ${actualDelta.toFixed(2)} — values may be misread`,
      });
    }
  }

  return {
    parser: 'ocr-ai',
    parserVersion: '3',
    account: {
      iban,
      // Account holder name from the PDF was redacted before send and never
      // reaches us in plaintext; we don't persist it.
      bankName,
      currency: raw.currency ?? 'EUR',
    },
    period: {
      periodStart: parseIsoDate(raw.periodStart) ?? undefined,
      periodEnd: parseIsoDate(raw.periodEnd) ?? undefined,
      openingBalance: raw.openingBalance ?? undefined,
      closingBalance: raw.closingBalance ?? undefined,
      totalDebit: raw.totalDebit ?? undefined,
      totalCredit: raw.totalCredit ?? undefined,
    },
    transactions,
    warnings,
    extra: { aiProvider: result.provider, aiModel: result.model, redactionStats: replacements },
  };
}

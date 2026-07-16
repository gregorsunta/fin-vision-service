import Papa from 'papaparse';
import { createLogger } from '../../utils/logger.js';
import { findIbanInText, detectBankName } from './iban-utils.js';
import { redactField } from './pii-filter.js';
import type { ParsedStatement, ParsedTransaction, ParsingWarning } from './types.js';

const log = createLogger('services.bank-statement.csv-parser');

const DATE_FORMATS: Array<{ re: RegExp; order: 'dmy' | 'mdy' | 'ymd' }> = [
  { re: /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/, order: 'ymd' },
  { re: /^(\d{1,2})[./-](\d{1,2})[./-](\d{4})$/, order: 'dmy' },
  { re: /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/, order: 'mdy' },
];

function parseDate(value: string): Date | null {
  const trimmed = value.trim();
  for (const { re, order } of DATE_FORMATS) {
    const m = trimmed.match(re);
    if (!m) continue;
    let d: number, mo: number, y: number;
    if (order === 'ymd') {
      [, y, mo, d] = m.map(Number) as unknown as [never, number, number, number];
    } else if (order === 'dmy') {
      [, d, mo, y] = m.map(Number) as unknown as [never, number, number, number];
    } else {
      [, mo, d, y] = m.map(Number) as unknown as [never, number, number, number];
    }
    const date = new Date(Date.UTC(y, mo - 1, d));
    if (!isNaN(date.getTime())) return date;
  }
  return null;
}

/**
 * Parses European ("1.234,56") or US ("1,234.56") decimal formats.
 * Empty/dash strings return null (commonly seen for a zero debit/credit column).
 */
function parseAmount(value: string | null | undefined): number | null {
  if (value == null) return null;
  const trimmed = String(value).trim();
  if (!trimmed || trimmed === '-' || trimmed === '—') return null;
  const hasComma = trimmed.includes(',');
  const hasDot = trimmed.includes('.');
  let normalized: string;
  if (hasComma && hasDot) {
    // assume last separator is decimal
    normalized = trimmed.lastIndexOf(',') > trimmed.lastIndexOf('.')
      ? trimmed.replace(/\./g, '').replace(',', '.')
      : trimmed.replace(/,/g, '');
  } else if (hasComma) {
    normalized = trimmed.replace(/\./g, '').replace(',', '.');
  } else {
    normalized = trimmed.replace(/,/g, '');
  }
  const num = Number(normalized);
  return isNaN(num) ? null : num;
}

function detectDelimiter(sample: string): string {
  const candidates = [';', ',', '\t', '|'];
  let best = ',';
  let bestScore = -1;
  for (const c of candidates) {
    const counts = sample.split(/\r?\n/).slice(0, 10).map((line) => line.split(c).length - 1);
    // consistency score: prefer delimiter that appears the same number of times on most lines
    const first = counts[0];
    if (first === 0) continue;
    const consistent = counts.filter((n) => n === first && n > 0).length;
    if (consistent > bestScore) {
      bestScore = consistent;
      best = c;
    }
  }
  return best;
}

/**
 * Heuristic column mapping: tries to find date/debit/credit/description columns
 * from typical Slovenian/English bank export header names. Falls back to positional
 * assumption if no recognizable headers exist.
 */
interface ColumnMap {
  date: number;
  valueDate?: number;
  description?: number;
  debit?: number;
  credit?: number;
  amount?: number;
  balance?: number;
}

/**
 * Header mapping is intentionally narrow per the GDPR whitelist. Counterparty
 * name/IBAN columns and reference (sklic) columns are NOT mapped here even
 * when the CSV provides them — those values must never reach the rest of the
 * pipeline. The "description" column is the only free-text source we read.
 */
function mapHeaders(headers: string[]): ColumnMap | null {
  const lower = headers.map((h) => (h ?? '').toLowerCase().trim());
  const find = (patterns: string[]): number | undefined => {
    for (let i = 0; i < lower.length; i++) {
      if (patterns.some((p) => lower[i].includes(p))) return i;
    }
    return undefined;
  };
  const date = find(['datum knjiž', 'datum valute', 'datum prometa', 'datum', 'booking date', 'date']);
  if (date === undefined) return null;

  return {
    date,
    valueDate: find(['valuta', 'value date', 'datum valute']),
    description: find(['namen', 'opis', 'description', 'details', 'narrative']),
    debit: find(['breme', 'debit', 'odliv']),
    credit: find(['dobro', 'credit', 'priliv']),
    amount: find(['znesek', 'amount']),
    balance: find(['stanje', 'balance', 'saldo']),
  };
}

export interface CsvParseInput {
  buffer: Buffer;
  encoding?: BufferEncoding;
}

export async function parseStatementCsv(input: CsvParseInput): Promise<ParsedStatement> {
  const text = input.buffer.toString(input.encoding ?? 'utf8');
  const warnings: ParsingWarning[] = [];

  const headerLineEnd = text.indexOf('\n');
  const header = text.slice(0, headerLineEnd);
  const sample = text.slice(0, Math.min(text.length, 2048));
  const delimiter = detectDelimiter(sample);
  log.debug({ delimiter, headerPreview: header.slice(0, 200) }, 'detected csv dialect');

  const parsed = Papa.parse<string[]>(text, {
    delimiter,
    skipEmptyLines: true,
  });

  if (parsed.errors.length) {
    for (const err of parsed.errors.slice(0, 5)) {
      warnings.push({ code: 'csv_parse_error', message: err.message, row: err.row });
    }
  }

  const rows = parsed.data as string[][];
  if (rows.length < 2) {
    throw new Error('CSV has no data rows');
  }

  // Find the header row: scan first 30 lines for one that maps cleanly.
  let headerRowIdx = -1;
  let columns: ColumnMap | null = null;
  for (let i = 0; i < Math.min(rows.length, 30); i++) {
    const candidate = mapHeaders(rows[i]);
    if (candidate) {
      headerRowIdx = i;
      columns = candidate;
      break;
    }
  }
  if (!columns || headerRowIdx < 0) {
    throw new Error('Could not identify CSV header row');
  }

  // Account metadata commonly appears in the rows above the header.
  const preHeaderText = rows.slice(0, headerRowIdx).flat().join('\n');
  const iban = findIbanInText(preHeaderText) ?? undefined;
  const bankName = iban ? detectBankName(iban) : undefined;

  const transactions: ParsedTransaction[] = [];
  for (let i = headerRowIdx + 1; i < rows.length; i++) {
    const row = rows[i];
    if (row.every((c) => !c || !c.trim())) continue;

    const rawDate = row[columns.date];
    const date = rawDate ? parseDate(rawDate) : null;
    if (!date) {
      warnings.push({ code: 'row_unparseable_date', message: `Row ${i}: ${rawDate}`, row: i });
      continue;
    }

    const debit = columns.debit !== undefined ? parseAmount(row[columns.debit]) : null;
    const credit = columns.credit !== undefined ? parseAmount(row[columns.credit]) : null;
    let finalDebit = debit ?? undefined;
    let finalCredit = credit ?? undefined;

    // Amount column (when debit/credit are not split): negative = debit, positive = credit
    if (finalDebit == null && finalCredit == null && columns.amount !== undefined) {
      const amount = parseAmount(row[columns.amount]);
      if (amount != null) {
        if (amount < 0) finalDebit = Math.abs(amount);
        else finalCredit = amount;
      }
    }

    if (finalDebit == null && finalCredit == null) {
      warnings.push({ code: 'row_missing_amount', message: `Row ${i} has no debit/credit`, row: i });
      continue;
    }

    // Description column is the only free-text source we touch. Counterparty
    // name/IBAN and sklic columns are dropped at parse time, before redaction
    // — guarantees their values never reach the DB or any LLM call.
    const descRaw = columns.description !== undefined ? (row[columns.description] ?? '').trim() : '';
    const description = redactField(descRaw, { primaryIban: iban });

    const valueDateRaw = columns.valueDate !== undefined ? row[columns.valueDate] : undefined;
    const balanceRaw = columns.balance !== undefined ? row[columns.balance] : undefined;

    transactions.push({
      transactionDate: date,
      valueDate: valueDateRaw ? parseDate(valueDateRaw) ?? undefined : undefined,
      description: description ?? undefined,
      debit: finalDebit,
      credit: finalCredit,
      runningBalance: balanceRaw ? parseAmount(balanceRaw) ?? undefined : undefined,
      currency: 'EUR',
      confidenceScores: { date: 0.95, amount: 0.95, description: description ? 0.85 : 0.0 },
    });
  }

  // Period inferred from the transaction range; specific statement headers may
  // override this later if present.
  const periodStart = transactions.length ? transactions.reduce((min, t) => (t.transactionDate < min ? t.transactionDate : min), transactions[0].transactionDate) : undefined;
  const periodEnd = transactions.length ? transactions.reduce((max, t) => (t.transactionDate > max ? t.transactionDate : max), transactions[0].transactionDate) : undefined;
  const totalDebit = transactions.reduce((sum, t) => sum + (t.debit ?? 0), 0);
  const totalCredit = transactions.reduce((sum, t) => sum + (t.credit ?? 0), 0);

  return {
    parser: 'csv',
    parserVersion: '1',
    account: { iban, bankName, currency: 'EUR' },
    period: { periodStart, periodEnd, totalDebit, totalCredit },
    transactions,
    warnings,
    extra: { delimiter, headerRow: headerRowIdx, columns },
  };
}

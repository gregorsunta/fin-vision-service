/**
 * Local structural parser for Revolut statement exports. Called on text
 * that has ALREADY been through the full redaction pipeline (structural
 * whitelist + NER, run once on the whole document upstream). Each
 * transaction's main line has the shape:
 *
 *   D. mmm YYYY <title> <amount>€ <balance>€
 *
 * Unlike OTP, the counterparty (for P2P transfers) appears directly in the
 * title on this same line — e.g. "Transfer to GREGOR SUNTA & Urska Sunta" or
 * the auto-generated "To Občina Podlehnik". The upstream pass's
 * "Transfer to/from" pattern already catches the first shape; the bare
 * "To NAME" shape (no colon, no "Transfer" prefix) isn't covered by that
 * general pattern (too permissive to use outside an isolated title field),
 * so redactTransferTitle() catches it here as a second layer, reusing the
 * same institutional whitelist. Applying it to already-redacted text is
 * harmless — a bracketed "[OSEBA]" token doesn't match its candidate shape.
 */

import { findIbanInText } from '../iban-utils.js';
import { redactTransferTitle } from '../pii-filter.js';
import type { ParsedStatement, ParsingWarning } from '../types.js';
import type { LocalStatementParser } from './types.js';
import { makeDate, monthFromToken, parseEuropeanNumber } from './number-date-utils.js';
import { classifyDebitCredit, reconcileTotals, type RawLocalRow } from './reconciliation.js';

function matches(text: string): boolean {
  return text.includes('Revolut Bank UAB');
}

const MAIN_ROW_RE = /^(\d{1,2})\.\s*([\p{L}]+)\.?\s+(\d{4})\s+(.+?)\s+([\d.]+,\d{2})€\s+([\d.]+,\d{2})€$/u;

function parseMainRow(line: string): { date: Date; amount: number; balance: number; description?: string } | null {
  const m = MAIN_ROW_RE.exec(line.trim());
  if (!m) return null;
  const [, dd, monthToken, yyyy, title, amountStr, balanceStr] = m;
  const month = monthFromToken(monthToken);
  if (!month) return null;
  const date = makeDate(Number(dd), month, Number(yyyy));
  if (!date) return null;

  return {
    date,
    amount: parseEuropeanNumber(amountStr),
    balance: parseEuropeanNumber(balanceStr),
    description: redactTransferTitle(title.trim()),
  };
}

interface RevolutHeader {
  iban?: string;
  openingBalance?: number;
  totalDebit?: number;
  totalCredit?: number;
  closingBalance?: number;
  periodStart?: Date;
  periodEnd?: Date;
}

function parseDateWords(day: string, monthToken: string, year: string): Date | undefined {
  const month = monthFromToken(monthToken);
  if (!month) return undefined;
  return makeDate(Number(day), month, Number(year)) ?? undefined;
}

function parseHeader(text: string): RevolutHeader {
  const iban = findIbanInText(text) ?? undefined;

  // "Account (<name>) <opening>€ <moneyOut>€ <moneyIn>€ <closing>€"
  const totalsMatch = /Account\s*\([^)]*\)\s+([\d.]+,\d{2})€\s+([\d.]+,\d{2})€\s+([\d.]+,\d{2})€\s+([\d.]+,\d{2})€/.exec(
    text,
  );
  const openingBalance = totalsMatch ? parseEuropeanNumber(totalsMatch[1]) : undefined;
  const totalDebit = totalsMatch ? parseEuropeanNumber(totalsMatch[2]) : undefined;
  const totalCredit = totalsMatch ? parseEuropeanNumber(totalsMatch[3]) : undefined;
  const closingBalance = totalsMatch ? parseEuropeanNumber(totalsMatch[4]) : undefined;

  // "... from D. mmm YYYY to D. mmm YYYY"
  const periodMatch =
    /from\s+(\d{1,2})\.\s*([\p{L}]+)\.?\s+(\d{4})\s+to\s+(\d{1,2})\.\s*([\p{L}]+)\.?\s+(\d{4})/u.exec(text);
  const periodStart = periodMatch ? parseDateWords(periodMatch[1], periodMatch[2], periodMatch[3]) : undefined;
  const periodEnd = periodMatch ? parseDateWords(periodMatch[4], periodMatch[5], periodMatch[6]) : undefined;

  return { iban, openingBalance, totalDebit, totalCredit, closingBalance, periodStart, periodEnd };
}

function parse(text: string): ParsedStatement | null {
  const lines = text.split('\n');
  const rows: RawLocalRow[] = [];

  for (const line of lines) {
    const main = parseMainRow(line);
    if (!main) continue;
    rows.push({
      transactionDate: main.date,
      amount: main.amount,
      balance: main.balance,
      description: main.description,
    });
  }

  if (rows.length === 0) return null;

  const header = parseHeader(text);
  const { transactions, warnings: classifyWarnings } = classifyDebitCredit(rows, header.openingBalance);
  const { warnings: reconcileWarnings, checksRun } = reconcileTotals(transactions, header);
  const warnings: ParsingWarning[] = [...classifyWarnings, ...reconcileWarnings];
  if (checksRun === 0) {
    warnings.push({
      code: 'no_reconciliation_possible',
      message: 'Statement header totals/balances could not be parsed — transaction extraction was not cross-validated',
    });
  }

  return {
    parser: 'local-rules',
    parserVersion: 'revolut-1',
    account: { iban: header.iban, bankName: 'Revolut Bank UAB', currency: 'EUR' },
    period: {
      periodStart: header.periodStart,
      periodEnd: header.periodEnd,
      openingBalance: header.openingBalance,
      closingBalance: header.closingBalance,
      totalDebit: header.totalDebit,
      totalCredit: header.totalCredit,
    },
    transactions,
    warnings,
    extra: { localParser: 'revolut' },
  };
}

export const revolutParser: LocalStatementParser = { id: 'revolut', matches, parse };

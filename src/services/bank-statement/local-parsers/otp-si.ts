/**
 * Local structural parser for the OTP banka d.d. Slovenian statement format.
 * Called on text that has ALREADY been through the full redaction pipeline
 * (redactPIIWithNLP — structural whitelist + NER, run once on the whole
 * document upstream). Each transaction row has the shape:
 *
 *   DD.MM.YYYY <txnId> [<Prejemnik:|Plačnik:> <counterparty...>] <amount>,dd <balance>,dd <opis>
 *
 * The counterparty field (if present) is dropped entirely regardless of
 * whether redaction already tokenised it — per the whitelist policy,
 * counterparty_name must not be persisted at all, only the trailing "Opis"
 * text (merchant name / transaction-type descriptor) becomes `description`.
 */

import { findIbanInText, detectBankName } from '../iban-utils.js';
import type { ParsedStatement, ParsingWarning } from '../types.js';
import type { LocalStatementParser } from './types.js';
import { MONEY_RE, makeDate, parseEuropeanNumber } from './number-date-utils.js';
import { classifyDebitCredit, reconcileTotals, type RawLocalRow } from './reconciliation.js';

function matches(text: string): boolean {
  return text.includes('KBMASI2X') || text.includes('OTP banka');
}

function parseMainRow(line: string): { date: Date; amount: number; balance: number; description?: string } | null {
  const m = /^(\d{2})\.(\d{2})\.(\d{4})\s+\d{6,}\s+(.*)$/.exec(line.trim());
  if (!m) return null;
  const [, dd, mm, yyyy, rest] = m;
  const date = makeDate(Number(dd), Number(mm), Number(yyyy));
  if (!date) return null;

  const moneyMatches = [...rest.matchAll(MONEY_RE)];
  if (moneyMatches.length < 2) return null; // not a transaction row (header/footer noise)

  const balanceMatch = moneyMatches[moneyMatches.length - 1];
  const amountMatch = moneyMatches[moneyMatches.length - 2];
  const descStart = balanceMatch.index! + balanceMatch[0].length;
  const description = rest.slice(descStart).trim() || undefined;

  return {
    date,
    amount: parseEuropeanNumber(amountMatch[0]),
    balance: parseEuropeanNumber(balanceMatch[0]),
    description,
  };
}

function parseValueDate(line: string | undefined): Date | undefined {
  if (!line) return undefined;
  const m = /^(\d{2})\.(\d{2})\.(\d{4})/.exec(line.trim());
  return m ? makeDate(Number(m[1]), Number(m[2]), Number(m[3])) ?? undefined : undefined;
}

interface OtpHeader {
  iban?: string;
  bankName?: string;
  openingBalance?: number;
  totalDebit?: number;
  totalCredit?: number;
  closingBalance?: number;
  periodStart?: Date;
  periodEnd?: Date;
}

function parseHeader(text: string): OtpHeader {
  const iban = findIbanInText(text) ?? undefined;
  const bankName = iban ? detectBankName(iban) ?? 'OTP banka d.d.' : 'OTP banka d.d.';

  // "EUR <opening> <totalDebit> <totalCredit> <closing>" summary line.
  const totalsMatch = /^EUR\s+([\d.]+,\d{2})\s+([\d.]+,\d{2})\s+([\d.]+,\d{2})\s+([\d.]+,\d{2})$/m.exec(text);
  const openingBalance = totalsMatch ? parseEuropeanNumber(totalsMatch[1]) : undefined;
  const totalDebit = totalsMatch ? parseEuropeanNumber(totalsMatch[2]) : undefined;
  const totalCredit = totalsMatch ? parseEuropeanNumber(totalsMatch[3]) : undefined;
  const closingBalance = totalsMatch ? parseEuropeanNumber(totalsMatch[4]) : undefined;

  const periodEndMatch = /Datum izpiska:\s*(\d{2})\.(\d{2})\.(\d{4})/.exec(text);
  const periodStartMatch = /Datum pre\.\s*izpiska:\s*(\d{2})\.(\d{2})\.(\d{4})/.exec(text);
  const periodEnd = periodEndMatch
    ? makeDate(Number(periodEndMatch[1]), Number(periodEndMatch[2]), Number(periodEndMatch[3])) ?? undefined
    : undefined;
  const periodStart = periodStartMatch
    ? makeDate(Number(periodStartMatch[1]), Number(periodStartMatch[2]), Number(periodStartMatch[3])) ?? undefined
    : undefined;

  return { iban, bankName, openingBalance, totalDebit, totalCredit, closingBalance, periodStart, periodEnd };
}

function parse(text: string): ParsedStatement | null {
  const lines = text.split('\n');
  const rows: RawLocalRow[] = [];

  for (let i = 0; i < lines.length; i++) {
    const main = parseMainRow(lines[i]);
    if (!main) continue;
    rows.push({
      transactionDate: main.date,
      valueDate: parseValueDate(lines[i + 1]),
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
    parserVersion: 'otp-si-1',
    account: { iban: header.iban, bankName: header.bankName, currency: 'EUR' },
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
    extra: { localParser: 'otp-si' },
  };
}

export const otpSiParser: LocalStatementParser = { id: 'otp-si', matches, parse };

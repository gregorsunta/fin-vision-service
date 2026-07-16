import type { ParsedTransaction, ParsingWarning } from '../types.js';

export interface RawLocalRow {
  transactionDate: Date;
  valueDate?: Date;
  amount: number;
  balance: number;
  description?: string;
}

const reconcileTolerance = (value: number) => Math.max(0.01, Math.abs(value) * 0.001);

/**
 * Neither local format labels which of a row's two money values is debit vs.
 * credit in a way that survives flat-text parsing (no reliable column to
 * trust). Instead, the sign of the running-balance delta tells us: balance
 * went up -> credit, went down -> debit. The delta's magnitude should also
 * equal the parsed amount — a mismatch means something upstream misread a
 * row, so it's flagged rather than silently trusted.
 */
export function classifyDebitCredit(
  rows: RawLocalRow[],
  openingBalance: number | undefined,
): { transactions: ParsedTransaction[]; warnings: ParsingWarning[] } {
  const transactions: ParsedTransaction[] = [];
  const warnings: ParsingWarning[] = [];
  let prevBalance = openingBalance;

  rows.forEach((row, idx) => {
    let debit: number | undefined;
    let credit: number | undefined;

    if (prevBalance !== undefined) {
      const delta = row.balance - prevBalance;
      if (Math.abs(Math.abs(delta) - row.amount) > reconcileTolerance(row.amount)) {
        warnings.push({
          code: 'balance_delta_mismatch',
          message: `row ${idx}: balance delta ${delta.toFixed(2)} doesn't match parsed amount ${row.amount.toFixed(2)}`,
          row: idx,
        });
      }
      if (delta >= 0) credit = row.amount;
      else debit = row.amount;
    } else {
      warnings.push({
        code: 'no_prior_balance',
        message: `row ${idx}: cannot determine debit/credit without a prior balance`,
        row: idx,
      });
    }

    transactions.push({
      transactionDate: row.transactionDate,
      valueDate: row.valueDate,
      description: row.description,
      debit,
      credit,
      runningBalance: row.balance,
      currency: 'EUR',
      confidenceScores: { date: 1, amount: 1, description: row.description ? 1 : 0 },
    });

    prevBalance = row.balance;
  });

  return { transactions, warnings };
}

/**
 * Cross-checks parsed transactions against the statement header's own
 * totals. Each of the three checks only runs if its header field(s) parsed;
 * if a header field is missing, that check is silently skipped rather than
 * failing — which means a statement whose header didn't parse at all could
 * previously produce *zero* warnings despite zero verification having
 * happened. `checksRun` makes that state visible: the caller pushes a
 * `no_reconciliation_possible` warning when it's 0, so `warnings.length`
 * (which the worker already uses to mark an upload `partly_completed`
 * instead of `completed`) actually reflects verification coverage.
 */
export function reconcileTotals(
  transactions: ParsedTransaction[],
  period: { openingBalance?: number; closingBalance?: number; totalDebit?: number; totalCredit?: number },
): { warnings: ParsingWarning[]; checksRun: number } {
  const warnings: ParsingWarning[] = [];
  let checksRun = 0;
  const sumDebit = transactions.reduce((s, t) => s + (t.debit ?? 0), 0);
  const sumCredit = transactions.reduce((s, t) => s + (t.credit ?? 0), 0);

  if (period.totalDebit !== undefined) {
    checksRun++;
    if (Math.abs(sumDebit - period.totalDebit) > reconcileTolerance(period.totalDebit)) {
      warnings.push({
        code: 'total_debit_mismatch',
        message: `Sum of debits ${sumDebit.toFixed(2)} != stated total ${period.totalDebit.toFixed(2)}`,
      });
    }
  }
  if (period.totalCredit !== undefined) {
    checksRun++;
    if (Math.abs(sumCredit - period.totalCredit) > reconcileTolerance(period.totalCredit)) {
      warnings.push({
        code: 'total_credit_mismatch',
        message: `Sum of credits ${sumCredit.toFixed(2)} != stated total ${period.totalCredit.toFixed(2)}`,
      });
    }
  }
  if (period.openingBalance !== undefined && period.closingBalance !== undefined) {
    checksRun++;
    const expectedDelta = period.closingBalance - period.openingBalance;
    const actualDelta = sumCredit - sumDebit;
    const tolerance = reconcileTolerance(Math.max(Math.abs(period.openingBalance), Math.abs(period.closingBalance)));
    if (Math.abs(expectedDelta - actualDelta) > tolerance) {
      warnings.push({
        code: 'balance_delta_mismatch',
        message: `Opening->closing delta ${expectedDelta.toFixed(2)} != sum(credit-debit) ${actualDelta.toFixed(2)}`,
      });
    }
  }
  return { warnings, checksRun };
}

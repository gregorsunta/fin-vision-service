/**
 * Transaction ↔ Receipt matcher.
 *
 * GDPR note: counterparty names are not persisted on bank_transactions
 * (whitelist policy). The matcher therefore relies on amount + date only,
 * with a soft bonus when the redacted description happens to overlap with
 * the receipt's store name. That bonus is opportunistic — never required.
 *
 * Scoring (out of 100):
 *   amount       0-60   exact / within €0.01 / within 1 / 2%
 *   date         0-30   same day / ±1 / ±3 days
 *   description  0-10   word-overlap bonus on redacted description
 *
 * Threshold behavior:
 *   ≥90 → auto-confirm (userAction='confirmed')
 *   ≥70 → pending auto-suggest
 *   50-69 → pending, surfaced to user for manual pick
 *   <50 → ignored
 */

import { and, between, eq, gte, isNull, lte } from 'drizzle-orm';
import { db } from '../db/index.js';
import {
  bankTransactions,
  receipts,
  receiptUploads,
  transactionReceiptMatches,
} from '../db/schema.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('services.transaction-receipt-matcher');

const DATE_WINDOW_DAYS = 3;
const MIN_SCORE = 50;
const AUTO_CONFIRM_THRESHOLD = 90;

function normalizeName(s: string | null | undefined): string {
  if (!s) return '';
  return s.toLowerCase().replace(/[^a-z0-9]/g, '');
}

function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  const matrix: number[][] = [];
  for (let i = 0; i <= a.length; i++) matrix[i] = [i];
  for (let j = 0; j <= b.length; j++) matrix[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      matrix[i][j] = a[i - 1] === b[j - 1]
        ? matrix[i - 1][j - 1]
        : Math.min(matrix[i - 1][j - 1] + 1, matrix[i][j - 1] + 1, matrix[i - 1][j] + 1);
    }
  }
  return matrix[a.length][b.length];
}

function stringSimilarity(a: string, b: string): number {
  const na = normalizeName(a);
  const nb = normalizeName(b);
  if (!na || !nb) return 0;
  if (na === nb) return 1;
  const maxLen = Math.max(na.length, nb.length);
  return 1 - levenshtein(na, nb) / maxLen;
}

function dayDifference(d1: Date, d2: Date): number {
  const msPerDay = 24 * 3600 * 1000;
  return Math.abs(d1.getTime() - d2.getTime()) / msPerDay;
}

export interface MatchFactors {
  amount: { score: number; difference: number };
  date: { score: number; daysDifference: number };
  description: { score: number; overlap: number };
}

export interface MatchCandidate {
  transactionId: number;
  receiptId: number;
  score: number;
  factors: MatchFactors;
}

function scoreMatch(tx: {
  transactionDate: Date;
  debit: number | null;
  credit: number | null;
  description: string | null;
}, receipt: {
  transactionDate: Date | null;
  totalAmount: number | null;
  storeName: string | null;
}): MatchCandidate['factors'] | null {
  if (!receipt.transactionDate || receipt.totalAmount == null) return null;
  const txAmount = (tx.debit ?? 0) > 0 ? tx.debit! : tx.credit ?? 0;
  if (txAmount == null) return null;

  const amountDiff = Math.abs(txAmount - receipt.totalAmount);
  let amountScore = 0;
  if (amountDiff === 0) amountScore = 60;
  else if (amountDiff <= 0.01) amountScore = 55;
  else if (txAmount > 0 && amountDiff / txAmount <= 0.01) amountScore = 40;
  else if (txAmount > 0 && amountDiff / txAmount <= 0.02) amountScore = 25;
  else amountScore = 0;

  const days = dayDifference(tx.transactionDate, receipt.transactionDate);
  let dateScore = 0;
  if (days <= 0) dateScore = 30;
  else if (days <= 1) dateScore = 22;
  else if (days <= DATE_WINDOW_DAYS) dateScore = 12;

  // Opportunistic description-vs-storeName overlap. The description is
  // PII-redacted but may still contain non-PII tokens (e.g. "Mercator",
  // "Spar"). When the receipt's storeName is a substring of the description
  // we award a small bonus; never required for a match to fire.
  const overlap = stringSimilarity(tx.description ?? '', receipt.storeName ?? '');
  const descriptionScore = Math.round(overlap * 10);

  return {
    amount: { score: amountScore, difference: amountDiff },
    date: { score: dateScore, daysDifference: days },
    description: { score: descriptionScore, overlap },
  };
}

/**
 * Find candidate receipt matches for a single transaction. Only inserts rows
 * into transaction_receipt_matches when score ≥ MIN_SCORE; callers can
 * optionally receive all candidates for ranking.
 */
export async function matchTransactionToReceipts(transactionId: number): Promise<MatchCandidate[]> {
  const [tx] = await db
    .select()
    .from(bankTransactions)
    .where(and(eq(bankTransactions.id, transactionId), isNull(bankTransactions.deletedAt)));
  if (!tx || !tx.transactionDate) return [];

  const windowStart = new Date(tx.transactionDate);
  windowStart.setUTCDate(windowStart.getUTCDate() - DATE_WINDOW_DAYS);
  const windowEnd = new Date(tx.transactionDate);
  windowEnd.setUTCDate(windowEnd.getUTCDate() + DATE_WINDOW_DAYS);

  const candidateReceipts = await db
    .select({
      id: receipts.id,
      storeName: receipts.storeName,
      totalAmount: receipts.totalAmount,
      transactionDate: receipts.transactionDate,
      uploadUserId: receiptUploads.userId,
    })
    .from(receipts)
    .innerJoin(receiptUploads, eq(receipts.uploadId, receiptUploads.id))
    .where(and(
      eq(receiptUploads.userId, tx.userId),
      between(receipts.transactionDate, windowStart, windowEnd),
      isNull(receipts.deletedAt),
    ));

  const scored: MatchCandidate[] = [];
  for (const r of candidateReceipts) {
    const factors = scoreMatch(
      {
        transactionDate: tx.transactionDate,
        debit: tx.debit != null ? Number(tx.debit) : null,
        credit: tx.credit != null ? Number(tx.credit) : null,
        description: tx.description,
      },
      {
        transactionDate: r.transactionDate,
        totalAmount: r.totalAmount != null ? Number(r.totalAmount) : null,
        storeName: r.storeName,
      },
    );
    if (!factors) continue;
    const total = factors.amount.score + factors.date.score + factors.description.score;
    if (total < MIN_SCORE) continue;
    scored.push({ transactionId: tx.id, receiptId: r.id, score: total, factors });
  }

  scored.sort((a, b) => b.score - a.score);
  await persistMatches(scored);
  return scored;
}

async function persistMatches(candidates: MatchCandidate[]): Promise<void> {
  if (!candidates.length) return;
  for (const c of candidates) {
    const [existing] = await db
      .select()
      .from(transactionReceiptMatches)
      .where(and(
        eq(transactionReceiptMatches.transactionId, c.transactionId),
        eq(transactionReceiptMatches.receiptId, c.receiptId),
      ));
    if (existing) continue; // don't overwrite user decisions
    const userAction = c.score >= AUTO_CONFIRM_THRESHOLD ? 'confirmed' : 'pending';
    await db.insert(transactionReceiptMatches).values({
      transactionId: c.transactionId,
      receiptId: c.receiptId,
      confidenceScore: c.score.toFixed(2),
      matchFactors: c.factors,
      userAction,
    });
  }
}

/**
 * Run matching for every transaction of a statement upload. Used by the
 * bank-statement worker after transactions are inserted.
 */
export async function matchStatementUploadTransactions(uploadId: number): Promise<void> {
  const txs = await db
    .select({ id: bankTransactions.id })
    .from(bankTransactions)
    .where(and(eq(bankTransactions.statementUploadId, uploadId), isNull(bankTransactions.deletedAt)));

  log.info({ uploadId, count: txs.length }, 'matching statement transactions to receipts');
  for (const { id } of txs) {
    try {
      await matchTransactionToReceipts(id);
    } catch (err) {
      log.warn({ err, transactionId: id }, 'match failed for transaction');
    }
  }
}

/**
 * Re-run matching for every transaction of a user within a window of a
 * changed receipt. Called from the receipt edit flow so that updated
 * totals/dates/store names propagate into pending matches.
 */
export async function matchReceiptToTransactions(receiptId: number): Promise<MatchCandidate[]> {
  const [receiptRow] = await db
    .select({
      id: receipts.id,
      storeName: receipts.storeName,
      totalAmount: receipts.totalAmount,
      transactionDate: receipts.transactionDate,
      uploadUserId: receiptUploads.userId,
    })
    .from(receipts)
    .innerJoin(receiptUploads, eq(receipts.uploadId, receiptUploads.id))
    .where(and(eq(receipts.id, receiptId), isNull(receipts.deletedAt)));

  if (!receiptRow || !receiptRow.transactionDate || receiptRow.totalAmount == null) return [];

  const windowStart = new Date(receiptRow.transactionDate);
  windowStart.setUTCDate(windowStart.getUTCDate() - DATE_WINDOW_DAYS);
  const windowEnd = new Date(receiptRow.transactionDate);
  windowEnd.setUTCDate(windowEnd.getUTCDate() + DATE_WINDOW_DAYS);

  const txs = await db
    .select()
    .from(bankTransactions)
    .where(and(
      eq(bankTransactions.userId, receiptRow.uploadUserId),
      gte(bankTransactions.transactionDate, windowStart),
      lte(bankTransactions.transactionDate, windowEnd),
      isNull(bankTransactions.deletedAt),
    ));

  const scored: MatchCandidate[] = [];
  for (const tx of txs) {
    if (!tx.transactionDate) continue;
    const factors = scoreMatch(
      {
        transactionDate: tx.transactionDate,
        debit: tx.debit != null ? Number(tx.debit) : null,
        credit: tx.credit != null ? Number(tx.credit) : null,
        description: tx.description,
      },
      {
        transactionDate: receiptRow.transactionDate,
        totalAmount: Number(receiptRow.totalAmount),
        storeName: receiptRow.storeName,
      },
    );
    if (!factors) continue;
    const total = factors.amount.score + factors.date.score + factors.description.score;
    if (total < MIN_SCORE) continue;
    scored.push({ transactionId: tx.id, receiptId: receiptRow.id, score: total, factors });
  }

  scored.sort((a, b) => b.score - a.score);
  await persistMatches(scored);
  return scored;
}

export const MATCHER_THRESHOLDS = {
  MIN_SCORE,
  AUTO_CONFIRM_THRESHOLD,
  DATE_WINDOW_DAYS,
};

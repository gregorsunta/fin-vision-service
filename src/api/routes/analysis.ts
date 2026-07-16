import { FastifyInstance } from 'fastify';
import { and, between, eq, gte, isNull, inArray, lte, or } from 'drizzle-orm';
import { authenticate } from '../auth.js';
import { db } from '../../db/index.js';
import {
  bankTransactions,
  receipts,
  receiptUploads,
  transactionReceiptMatches,
} from '../../db/schema.js';
import { matchTransactionToReceipts } from '../../services/transaction-receipt-matcher.js';

function parseDateParam(v: string | undefined): Date | null {
  if (!v) return null;
  const d = new Date(v);
  return isNaN(d.getTime()) ? null : d;
}

function parseAmountParam(v: string | undefined): number | null {
  if (!v) return null;
  const n = Number(v);
  return isNaN(n) ? null : n;
}

/**
 * Amount-range filter against whichever of debit/credit is populated on a
 * row (a transaction is always exactly one or the other, never both) — "price
 * from/to" means the transaction's magnitude, regardless of direction.
 */
function amountRangeFilter(amountFrom: number | null, amountTo: number | null) {
  const conditions = [];
  if (amountFrom !== null) {
    conditions.push(or(gte(bankTransactions.debit, String(amountFrom)), gte(bankTransactions.credit, String(amountFrom))));
  }
  if (amountTo !== null) {
    conditions.push(or(lte(bankTransactions.debit, String(amountTo)), lte(bankTransactions.credit, String(amountTo))));
  }
  return conditions;
}

export default async function analysisRoutes(server: FastifyInstance) {
  // Unified view for the analysis page: transactions with match info +
  // orphan receipts (no matching transaction) in the same window.
  server.get('/analysis/matches', { preHandler: [authenticate] }, async (request, reply) => {
    if (!request.user) return reply.status(401).send({ error: 'Unauthorized' });
    const query = request.query as {
      from?: string;
      to?: string;
      bankAccountId?: string;
      amountFrom?: string;
      amountTo?: string;
    };
    const from = parseDateParam(query.from);
    const to = parseDateParam(query.to);
    if (!from || !to) return reply.status(400).send({ error: 'from and to dates required (ISO)' });
    const amountFrom = parseAmountParam(query.amountFrom);
    const amountTo = parseAmountParam(query.amountTo);

    const txFilters = [
      eq(bankTransactions.userId, request.user.id),
      between(bankTransactions.transactionDate, from, to),
      isNull(bankTransactions.deletedAt),
      ...amountRangeFilter(amountFrom, amountTo),
    ];
    if (query.bankAccountId) {
      const id = Number(query.bankAccountId);
      if (!isNaN(id)) txFilters.push(eq(bankTransactions.bankAccountId, id));
    }

    const txs = await db.select().from(bankTransactions).where(and(...txFilters));
    const txIds = txs.map((t) => t.id);

    const matches = txIds.length
      ? await db.select().from(transactionReceiptMatches).where(inArray(transactionReceiptMatches.transactionId, txIds))
      : [];

    const matchedReceiptIds = matches.map((m) => m.receiptId);

    // Orphan receipts: same user, same window, not referenced by any match.
    const receiptsInWindowRaw = await db
      .select({
        id: receipts.id,
        uploadId: receipts.uploadId,
        storeName: receipts.storeName,
        totalAmount: receipts.totalAmount,
        transactionDate: receipts.transactionDate,
        currency: receipts.currency,
        status: receipts.status,
      })
      .from(receipts)
      .innerJoin(receiptUploads, eq(receipts.uploadId, receiptUploads.id))
      .where(and(
        eq(receiptUploads.userId, request.user.id),
        between(receipts.transactionDate, from, to),
        isNull(receipts.deletedAt),
        eq(receipts.status, 'processed'),
      ));

    const matchedSet = new Set(matchedReceiptIds);
    const orphanReceipts = receiptsInWindowRaw.filter((r) => !matchedSet.has(r.id));

    // Hydrate each transaction with its matches and the associated receipt
    // snapshots so the UI can render side-by-side without a follow-up call.
    const receiptMap = new Map(receiptsInWindowRaw.map((r) => [r.id, r]));
    const matchesByTx = new Map<number, typeof matches>();
    for (const m of matches) {
      if (!matchesByTx.has(m.transactionId)) matchesByTx.set(m.transactionId, []);
      matchesByTx.get(m.transactionId)!.push(m);
    }

    const items = txs.map((t) => {
      const txMatches = matchesByTx.get(t.id) ?? [];
      const matchedReceipts = txMatches
        .map((m) => receiptMap.get(m.receiptId))
        .filter((r): r is NonNullable<typeof r> => !!r);
      return {
        transaction: t,
        matches: txMatches,
        matchedReceipts,
      };
    });

    return reply.send({
      from: from.toISOString(),
      to: to.toISOString(),
      transactionCount: txs.length,
      matchedCount: txs.filter((t) => matchesByTx.has(t.id)).length,
      orphanReceiptCount: orphanReceipts.length,
      items,
      orphanReceipts,
    });
  });

  // Create a manual match between a transaction and a receipt
  server.post('/analysis/matches', { preHandler: [authenticate] }, async (request, reply) => {
    if (!request.user) return reply.status(401).send({ error: 'Unauthorized' });
    const body = request.body as { transactionId?: number; receiptId?: number };
    if (!body.transactionId || !body.receiptId) return reply.status(400).send({ error: 'transactionId and receiptId required' });

    const [tx] = await db.select().from(bankTransactions).where(eq(bankTransactions.id, body.transactionId));
    if (!tx || tx.userId !== request.user.id) return reply.status(404).send({ error: 'Transaction not found' });

    const [r] = await db
      .select({ id: receipts.id, uploadId: receipts.uploadId, userId: receiptUploads.userId })
      .from(receipts)
      .innerJoin(receiptUploads, eq(receipts.uploadId, receiptUploads.id))
      .where(eq(receipts.id, body.receiptId));
    if (!r || r.userId !== request.user.id) return reply.status(404).send({ error: 'Receipt not found' });

    const [existing] = await db.select().from(transactionReceiptMatches).where(and(
      eq(transactionReceiptMatches.transactionId, body.transactionId),
      eq(transactionReceiptMatches.receiptId, body.receiptId),
    ));
    if (existing) {
      await db.update(transactionReceiptMatches)
        .set({ userAction: 'confirmed' })
        .where(eq(transactionReceiptMatches.id, existing.id));
      return reply.send({ ok: true, matchId: existing.id });
    }

    // Manual matches get confidenceScore=100 — the user is the source of truth.
    const [inserted] = await db.insert(transactionReceiptMatches).values({
      transactionId: body.transactionId,
      receiptId: body.receiptId,
      confidenceScore: '100.00',
      userAction: 'confirmed',
    }).$returningId();
    return reply.status(201).send({ ok: true, matchId: inserted.id });
  });

  // Confirm or reject an existing match
  server.patch('/analysis/matches/:id', { preHandler: [authenticate] }, async (request, reply) => {
    if (!request.user) return reply.status(401).send({ error: 'Unauthorized' });
    const id = Number((request.params as { id: string }).id);
    if (isNaN(id)) return reply.status(400).send({ error: 'Invalid id' });
    const body = request.body as { userAction?: 'confirmed' | 'rejected' };
    if (body.userAction !== 'confirmed' && body.userAction !== 'rejected') {
      return reply.status(400).send({ error: "userAction must be 'confirmed' or 'rejected'" });
    }

    // Ownership check by joining to the transaction.
    const [row] = await db
      .select({ id: transactionReceiptMatches.id, userId: bankTransactions.userId })
      .from(transactionReceiptMatches)
      .innerJoin(bankTransactions, eq(transactionReceiptMatches.transactionId, bankTransactions.id))
      .where(eq(transactionReceiptMatches.id, id));
    if (!row) return reply.status(404).send({ error: 'Match not found' });
    if (row.userId !== request.user.id) return reply.status(403).send({ error: 'Forbidden' });

    await db.update(transactionReceiptMatches).set({ userAction: body.userAction }).where(eq(transactionReceiptMatches.id, id));
    return reply.send({ ok: true });
  });

  server.delete('/analysis/matches/:id', { preHandler: [authenticate] }, async (request, reply) => {
    if (!request.user) return reply.status(401).send({ error: 'Unauthorized' });
    const id = Number((request.params as { id: string }).id);
    if (isNaN(id)) return reply.status(400).send({ error: 'Invalid id' });

    const [row] = await db
      .select({ id: transactionReceiptMatches.id, userId: bankTransactions.userId })
      .from(transactionReceiptMatches)
      .innerJoin(bankTransactions, eq(transactionReceiptMatches.transactionId, bankTransactions.id))
      .where(eq(transactionReceiptMatches.id, id));
    if (!row) return reply.status(404).send({ error: 'Match not found' });
    if (row.userId !== request.user.id) return reply.status(403).send({ error: 'Forbidden' });

    await db.delete(transactionReceiptMatches).where(eq(transactionReceiptMatches.id, id));
    return reply.send({ ok: true });
  });

  // Re-run matching for a given transaction (useful after the user edited it).
  server.post('/analysis/matches/rerun/:transactionId', { preHandler: [authenticate] }, async (request, reply) => {
    if (!request.user) return reply.status(401).send({ error: 'Unauthorized' });
    const txId = Number((request.params as { transactionId: string }).transactionId);
    if (isNaN(txId)) return reply.status(400).send({ error: 'Invalid id' });

    const [tx] = await db.select().from(bankTransactions).where(eq(bankTransactions.id, txId));
    if (!tx) return reply.status(404).send({ error: 'Transaction not found' });
    if (tx.userId !== request.user.id) return reply.status(403).send({ error: 'Forbidden' });

    const candidates = await matchTransactionToReceipts(txId);
    return reply.send({ candidates });
  });
}

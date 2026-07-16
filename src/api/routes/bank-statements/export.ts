import { FastifyInstance } from 'fastify';
import { and, between, desc, eq, gte, isNull, inArray, lte, or } from 'drizzle-orm';
import { authenticate } from '../../auth.js';
import { db } from '../../../db/index.js';
import {
  bankAccounts,
  bankStatementUploads,
  bankTransactions,
  receipts,
  receiptUploads,
  transactionReceiptMatches,
  users,
} from '../../../db/schema.js';
import {
  DEFAULT_EXPORT_OPTIONS,
  generateBankStatementUploadsCsv,
  generateBankTransactionsCsv,
  generateUnifiedCsv,
  type ExportOptions,
  type CsvBankTransaction,
  type CsvBankStatementUpload,
  type CsvUnifiedRow,
} from '../../../services/csvGenerator.js';

async function loadOpts(userId: number): Promise<ExportOptions> {
  const [user] = await db.select({ exportSettings: users.exportSettings }).from(users).where(eq(users.id, userId));
  return { ...DEFAULT_EXPORT_OPTIONS, ...(user?.exportSettings ?? {}) };
}

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

/** Amount-range filter against whichever of debit/credit is populated — see analysis.ts for the same helper. */
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

export default async function bankStatementExportRoutes(server: FastifyInstance) {
  // CSV: every bank transaction, optionally narrowed by account or period
  server.get('/users/me/bank-transactions/export-csv', { preHandler: [authenticate] }, async (request, reply) => {
    if (!request.user) return reply.status(401).send({ error: 'Unauthorized' });
    const opts = await loadOpts(request.user.id);
    const query = request.query as {
      bankAccountId?: string;
      from?: string;
      to?: string;
      amountFrom?: string;
      amountTo?: string;
    };
    const filters = [
      eq(bankTransactions.userId, request.user.id),
      isNull(bankTransactions.deletedAt),
      ...amountRangeFilter(parseAmountParam(query.amountFrom), parseAmountParam(query.amountTo)),
    ];
    if (query.bankAccountId) {
      const id = Number(query.bankAccountId);
      if (!isNaN(id)) filters.push(eq(bankTransactions.bankAccountId, id));
    }
    const from = parseDateParam(query.from);
    const to = parseDateParam(query.to);
    if (from && to) filters.push(between(bankTransactions.transactionDate, from, to));

    const rows = await db
      .select({
        id: bankTransactions.id,
        statementUploadId: bankTransactions.statementUploadId,
        bankAccountId: bankTransactions.bankAccountId,
        bankAccountIban: bankAccounts.iban,
        bankAccountName: bankAccounts.accountName,
        transactionDate: bankTransactions.transactionDate,
        valueDate: bankTransactions.valueDate,
        description: bankTransactions.description,
        debit: bankTransactions.debit,
        credit: bankTransactions.credit,
        runningBalance: bankTransactions.runningBalance,
        currency: bankTransactions.currency,
        category: bankTransactions.category,
        isDuplicate: bankTransactions.isDuplicate,
      })
      .from(bankTransactions)
      .innerJoin(bankAccounts, eq(bankTransactions.bankAccountId, bankAccounts.id))
      .where(and(...filters))
      .orderBy(desc(bankTransactions.transactionDate));

    const csv = generateBankTransactionsCsv(rows as unknown as CsvBankTransaction[], opts);
    reply.header('Content-Type', 'text/csv');
    reply.header('Content-Disposition', 'attachment; filename="bank_transactions.csv"');
    return reply.send(csv);
  });

  // CSV: list of bank statement uploads (meta only)
  server.get('/users/me/bank-statements/export-csv', { preHandler: [authenticate] }, async (request, reply) => {
    if (!request.user) return reply.status(401).send({ error: 'Unauthorized' });
    const opts = await loadOpts(request.user.id);

    const rows = await db
      .select({
        id: bankStatementUploads.id,
        uploadNumber: bankStatementUploads.uploadNumber,
        bankAccountIban: bankAccounts.iban,
        bankAccountName: bankAccounts.accountName,
        originalFileName: bankStatementUploads.originalFileName,
        periodStart: bankStatementUploads.periodStart,
        periodEnd: bankStatementUploads.periodEnd,
        openingBalance: bankStatementUploads.openingBalance,
        closingBalance: bankStatementUploads.closingBalance,
        totalDebit: bankStatementUploads.totalDebit,
        totalCredit: bankStatementUploads.totalCredit,
        status: bankStatementUploads.status,
        createdAt: bankStatementUploads.createdAt,
      })
      .from(bankStatementUploads)
      .leftJoin(bankAccounts, eq(bankStatementUploads.bankAccountId, bankAccounts.id))
      .where(and(eq(bankStatementUploads.userId, request.user.id), isNull(bankStatementUploads.deletedAt)))
      .orderBy(desc(bankStatementUploads.createdAt));

    const csv = generateBankStatementUploadsCsv(rows as unknown as CsvBankStatementUpload[], opts);
    reply.header('Content-Type', 'text/csv');
    reply.header('Content-Disposition', 'attachment; filename="bank_statements.csv"');
    return reply.send(csv);
  });

  // Unified CSV: matched rows + orphan transactions + orphan receipts
  server.get('/users/me/unified/export-csv', { preHandler: [authenticate] }, async (request, reply) => {
    if (!request.user) return reply.status(401).send({ error: 'Unauthorized' });
    const opts = await loadOpts(request.user.id);
    const query = request.query as {
      from?: string;
      to?: string;
      bankAccountId?: string;
      includeUnmatched?: string;
      amountFrom?: string;
      amountTo?: string;
    };
    const from = parseDateParam(query.from);
    const to = parseDateParam(query.to);
    const includeUnmatched = query.includeUnmatched !== 'false';

    const txFilters = [
      eq(bankTransactions.userId, request.user.id),
      isNull(bankTransactions.deletedAt),
      ...amountRangeFilter(parseAmountParam(query.amountFrom), parseAmountParam(query.amountTo)),
    ];
    if (from && to) txFilters.push(between(bankTransactions.transactionDate, from, to));
    if (query.bankAccountId) {
      const id = Number(query.bankAccountId);
      if (!isNaN(id)) txFilters.push(eq(bankTransactions.bankAccountId, id));
    }

    const txs = await db
      .select({
        id: bankTransactions.id,
        date: bankTransactions.transactionDate,
        debit: bankTransactions.debit,
        credit: bankTransactions.credit,
        currency: bankTransactions.currency,
        description: bankTransactions.description,
        bankAccountId: bankTransactions.bankAccountId,
        bankAccountName: bankAccounts.accountName,
        bankAccountIban: bankAccounts.iban,
      })
      .from(bankTransactions)
      .innerJoin(bankAccounts, eq(bankTransactions.bankAccountId, bankAccounts.id))
      .where(and(...txFilters));

    const txIds = txs.map((t) => t.id);
    const matches = txIds.length
      ? await db.select().from(transactionReceiptMatches).where(inArray(transactionReceiptMatches.transactionId, txIds))
      : [];
    const confirmedMatches = matches.filter((m) => m.userAction === 'confirmed');
    const matchedReceiptIds = confirmedMatches.map((m) => m.receiptId);

    const matchedReceiptRows = matchedReceiptIds.length
      ? await db
          .select({
            id: receipts.id,
            storeName: receipts.storeName,
            userReceiptNumber: receipts.userReceiptNumber,
            totalAmount: receipts.totalAmount,
            currency: receipts.currency,
            transactionDate: receipts.transactionDate,
          })
          .from(receipts)
          .where(inArray(receipts.id, matchedReceiptIds))
      : [];
    const receiptById = new Map(matchedReceiptRows.map((r) => [r.id, r]));

    const matchByTx = new Map<number, typeof confirmedMatches[number]>();
    for (const m of confirmedMatches) matchByTx.set(m.transactionId, m);

    const out: CsvUnifiedRow[] = [];

    for (const t of txs) {
      const m = matchByTx.get(t.id);
      const r = m ? receiptById.get(m.receiptId) ?? null : null;
      const amount = (t.debit ?? '0') !== '0' ? t.debit : t.credit;
      if (m && r) {
        out.push({
          source: 'matched',
          matchConfidence: Number(m.confidenceScore),
          date: t.date,
          amount,
          currency: t.currency ?? r.currency,
          transactionId: t.id,
          description: t.description,
          bankAccount: t.bankAccountName,
          bankAccountIban: t.bankAccountIban,
          receiptId: r.id,
          storeName: r.storeName,
          receiptNumber: String(r.userReceiptNumber),
        });
      } else if (includeUnmatched) {
        out.push({
          source: 'bank_statement_only',
          matchConfidence: null,
          date: t.date,
          amount,
          currency: t.currency,
          transactionId: t.id,
          description: t.description,
          bankAccount: t.bankAccountName,
          bankAccountIban: t.bankAccountIban,
          receiptId: null,
          storeName: null,
          receiptNumber: null,
          notes: 'No receipt found for this bank transaction',
        });
      }
    }

    if (includeUnmatched) {
      // Receipts without a confirmed bank match in the requested window
      const matchedSet = new Set(matchedReceiptIds);
      const receiptFilters = [
        eq(receiptUploads.userId, request.user.id),
        isNull(receipts.deletedAt),
        eq(receipts.status, 'processed'),
      ];
      if (from && to) receiptFilters.push(between(receipts.transactionDate, from, to));

      const orphanCandidates = await db
        .select({
          id: receipts.id,
          storeName: receipts.storeName,
          userReceiptNumber: receipts.userReceiptNumber,
          totalAmount: receipts.totalAmount,
          currency: receipts.currency,
          transactionDate: receipts.transactionDate,
        })
        .from(receipts)
        .innerJoin(receiptUploads, eq(receipts.uploadId, receiptUploads.id))
        .where(and(...receiptFilters));

      for (const r of orphanCandidates) {
        if (matchedSet.has(r.id)) continue;
        out.push({
          source: 'receipt_only',
          matchConfidence: null,
          date: r.transactionDate,
          amount: r.totalAmount,
          currency: r.currency,
          transactionId: null,
          description: null,
          bankAccount: null,
          bankAccountIban: null,
          receiptId: r.id,
          storeName: r.storeName,
          receiptNumber: String(r.userReceiptNumber),
          notes: 'Receipt without matching bank transaction (likely cash)',
        });
      }
    }

    out.sort((a, b) => {
      const ad = a.date instanceof Date ? a.date.getTime() : a.date ? new Date(a.date).getTime() : 0;
      const bd = b.date instanceof Date ? b.date.getTime() : b.date ? new Date(b.date).getTime() : 0;
      return bd - ad;
    });

    const csv = generateUnifiedCsv(out, opts);
    reply.header('Content-Type', 'text/csv');
    reply.header('Content-Disposition', 'attachment; filename="unified_export.csv"');
    return reply.send(csv);
  });
}

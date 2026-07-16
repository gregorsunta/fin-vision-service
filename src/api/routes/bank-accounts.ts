import { FastifyInstance } from 'fastify';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { authenticate } from '../auth.js';
import { db } from '../../db/index.js';
import { bankAccounts, bankStatementUploads, bankTransactions, receiptEditHistory } from '../../db/schema.js';
import { detectBankName, validateIban } from '../../services/bank-statement/iban-utils.js';

/**
 * CRUD endpoints for user-owned bank accounts.
 * Account creation during statement upload is automatic (in worker); these
 * endpoints are for manual management from the frontend.
 */
export default async function bankAccountRoutes(server: FastifyInstance) {
  // List all accounts owned by the current user
  server.get('/bank-accounts', { preHandler: [authenticate] }, async (request, reply) => {
    if (!request.user) return reply.status(401).send({ error: 'Unauthorized' });

    const rows = await db
      .select({
        id: bankAccounts.id,
        iban: bankAccounts.iban,
        accountName: bankAccounts.accountName,
        bankName: bankAccounts.bankName,
        currency: bankAccounts.currency,
        isAutoCreated: bankAccounts.isAutoCreated,
        createdAt: bankAccounts.createdAt,
        updatedAt: bankAccounts.updatedAt,
        statementCount: sql<number>`(SELECT COUNT(*) FROM ${bankStatementUploads} WHERE ${bankStatementUploads.bankAccountId} = ${bankAccounts.id} AND ${bankStatementUploads.deletedAt} IS NULL)`,
        transactionCount: sql<number>`(SELECT COUNT(*) FROM ${bankTransactions} WHERE ${bankTransactions.bankAccountId} = ${bankAccounts.id} AND ${bankTransactions.deletedAt} IS NULL)`,
      })
      .from(bankAccounts)
      .where(and(eq(bankAccounts.userId, request.user.id), isNull(bankAccounts.deletedAt)));

    return reply.send({ accounts: rows });
  });

  // Create a new bank account manually
  server.post('/bank-accounts', { preHandler: [authenticate] }, async (request, reply) => {
    if (!request.user) return reply.status(401).send({ error: 'Unauthorized' });
    const body = request.body as { iban?: string; accountName?: string; bankName?: string; currency?: string };
    if (!body?.iban) return reply.status(400).send({ error: 'IBAN is required' });

    const normalized = validateIban(body.iban);
    if (!normalized) return reply.status(400).send({ error: 'IBAN failed validation' });

    // Conflict if the IBAN already exists for this user (unique index enforces it anyway,
    // but we want a cleaner 409 than raw SQL error).
    const [existing] = await db.select().from(bankAccounts)
      .where(and(eq(bankAccounts.userId, request.user.id), eq(bankAccounts.iban, normalized.iban)));
    if (existing) {
      if (existing.deletedAt) {
        return reply.status(409).send({ error: 'IBAN was previously deleted. Restore via admin or use a different IBAN.' });
      }
      return reply.status(409).send({ error: 'Bank account with this IBAN already exists', accountId: existing.id });
    }

    const [inserted] = await db.insert(bankAccounts).values({
      userId: request.user.id,
      iban: normalized.iban,
      accountName: body.accountName ?? null,
      bankName: body.bankName ?? detectBankName(normalized.iban) ?? null,
      currency: body.currency ?? 'EUR',
      isAutoCreated: false,
    }).$returningId();

    return reply.status(201).send({ id: inserted.id, iban: normalized.iban });
  });

  // Rename / relabel an existing account. IBAN itself is immutable.
  server.patch('/bank-accounts/:id', { preHandler: [authenticate] }, async (request, reply) => {
    if (!request.user) return reply.status(401).send({ error: 'Unauthorized' });
    const id = Number((request.params as { id: string }).id);
    if (isNaN(id)) return reply.status(400).send({ error: 'Invalid id' });

    const [existing] = await db.select().from(bankAccounts).where(eq(bankAccounts.id, id));
    if (!existing || existing.deletedAt) return reply.status(404).send({ error: 'Not found' });
    if (existing.userId !== request.user.id) return reply.status(403).send({ error: 'Forbidden' });

    const body = request.body as { accountName?: string | null; bankName?: string | null; currency?: string };
    const updates: Partial<typeof bankAccounts.$inferInsert> = {};
    if ('accountName' in body) updates.accountName = body.accountName ?? null;
    if ('bankName' in body) updates.bankName = body.bankName ?? null;
    if (body.currency) updates.currency = body.currency;

    if (Object.keys(updates).length === 0) {
      return reply.status(400).send({ error: 'No fields to update' });
    }

    await db.transaction(async (tx) => {
      await tx.update(bankAccounts).set(updates).where(eq(bankAccounts.id, id));
      for (const [field, value] of Object.entries(updates)) {
        const oldValue = (existing as Record<string, unknown>)[field];
        await tx.insert(receiptEditHistory).values({
          entityType: 'bank_account',
          entityId: id,
          fieldName: field,
          oldValue: oldValue == null ? null : String(oldValue),
          newValue: value == null ? null : String(value),
          changedBy: request.user!.id,
        });
      }
    });

    return reply.send({ ok: true });
  });

  // Soft delete. Keeps statements and transactions in place so the audit
  // trail + training corpus remain intact; the UI just hides the account.
  server.delete('/bank-accounts/:id', { preHandler: [authenticate] }, async (request, reply) => {
    if (!request.user) return reply.status(401).send({ error: 'Unauthorized' });
    const id = Number((request.params as { id: string }).id);
    if (isNaN(id)) return reply.status(400).send({ error: 'Invalid id' });

    const [existing] = await db.select().from(bankAccounts).where(eq(bankAccounts.id, id));
    if (!existing || existing.deletedAt) return reply.status(404).send({ error: 'Not found' });
    if (existing.userId !== request.user.id) return reply.status(403).send({ error: 'Forbidden' });

    await db.update(bankAccounts).set({ deletedAt: new Date() }).where(eq(bankAccounts.id, id));
    return reply.send({ ok: true });
  });
}

import { randomBytes } from 'crypto';
import { FastifyInstance } from 'fastify';
import { db, users, receiptUploads, receipts, lineItems, processingErrors, duplicateMatches } from '../../db/index.js';
import { eq, inArray, desc, asc, sql, count, or } from 'drizzle-orm';
import { authenticate } from '../auth.js';
import fs from 'fs/promises';
import { deleteFile } from '../../utils/file-utils.js';
import path from 'path';
import { fileURLToPath } from 'url';
import { generateReceiptsCsv, generateItemsCsv, generateUploadsCsv, DEFAULT_EXPORT_OPTIONS, type CsvReceipt, type ExportOptions } from '../../services/csvGenerator.js';
import {
  hashPassword,
  comparePasswords,
  generateAccessToken,
  generateRefreshToken,
  verifyToken,
  UserPayload,
} from '../../services/authService.js';

import { z } from 'zod';
import { registrationSchema, loginSchema } from '../../validation/authSchemas.js';

export default async function userRoutes(server: FastifyInstance) {

  // --- User Registration ---
  server.post('/users', async (request, reply) => {
    try {
      const { email, password } = registrationSchema.parse(request.body);

      const existingUser = await db.query.users.findFirst({ where: eq(users.email, email) });
      if (existingUser) {
        return reply.status(409).send({ error: 'A user with this email already exists.' });
      }

      const hashedPassword = await hashPassword(password);
      const apiKey = `usk_${randomBytes(24).toString('hex')}`;

      const result = await db.insert(users).values({
        email,
        password: hashedPassword,
        apiKey,
      });

      reply.status(201).send({
        userId: result[0].insertId,
        email,
        apiKey,
        message: 'User created successfully.',
      });
    } catch (error: any) {
      if (error instanceof z.ZodError) {
        return reply.status(400).send({ error: 'Validation failed', details: error.flatten().fieldErrors });
      }
      request.log.error({ err: error }, 'Failed to create new user');
      reply.status(500).send({ error: 'Could not create user.', details: error });
    }
  });

  // --- User Login ---
  server.post('/auth/login', async (request, reply) => {
    try {
      const { email, password } = loginSchema.parse(request.body);

      const user = await db.query.users.findFirst({ where: eq(users.email, email) });
      if (!user) {
        return reply.status(401).send({ error: 'Invalid credentials.' });
      }

      const isPasswordValid = await comparePasswords(password, user.password!);
      if (!isPasswordValid) {
        return reply.status(401).send({ error: 'Invalid credentials.' });
      }

      const userPayload: UserPayload = { id: user.id, email: user.email! };
      const accessToken = generateAccessToken(userPayload);
      const refreshToken = await generateRefreshToken(user.id);

      // Send refresh token as a secure, HttpOnly cookie
      reply.setCookie('refreshToken', refreshToken, {
        httpOnly: true,
        secure: process.env.NODE_ENV !== 'development', // Use secure cookies in production
        path: '/api/auth/refresh-token',
        sameSite: 'strict',
        maxAge: 7 * 24 * 60 * 60, // 7 days
      });

      reply.send({ accessToken });
    } catch (error: any) {
      if (error instanceof z.ZodError) {
        return reply.status(400).send({ error: 'Validation failed', details: error.flatten().fieldErrors });
      }
      request.log.error({ err: error }, 'Login failed');
      reply.status(500).send({ error: 'Internal Server Error' });
    }
  });
  
  // --- Refresh Access Token ---
  server.post('/auth/refresh-token', async (request, reply) => {
    const refreshTokenFromCookie = request.cookies.refreshToken;

    if (!refreshTokenFromCookie) {
        return reply.status(401).send({ error: 'No refresh token found.' });
    }

    try {
        const decoded = verifyToken<{ id: number }>(refreshTokenFromCookie, process.env.REFRESH_TOKEN_SECRET!);

        const user = await db.query.users.findFirst({
            where: (users, { eq }) => eq(users.id, decoded.id),
        });

        if (!user || user.refreshToken !== refreshTokenFromCookie) {
            return reply.status(403).send({ error: 'Invalid refresh token.' });
        }

        const userPayload: UserPayload = { id: user.id, email: user.email! };
        const newAccessToken = generateAccessToken(userPayload);

        reply.send({ accessToken: newAccessToken });
    } catch (err) {
        reply.status(403).send({ error: 'Invalid or expired refresh token.' });
    }
  });


  // --- User Logout ---
  server.post('/auth/logout', { preHandler: [authenticate] }, async (request, reply) => {
    if (!request.user) {
      return reply.status(401).send({ error: 'Authentication required.' });
    }
    
    // Clear the refresh token from the database
    await db.update(users)
      .set({ refreshToken: null })
      .where(eq(users.id, request.user.id));
      
    reply.clearCookie('refreshToken', { path: '/api/auth/refresh-token' });
    reply.status(204).send();
  });


  // --- Get All Uploads for Authenticated User ---
  server.get('/users/me/uploads', { preHandler: [authenticate] }, async (request, reply) => {
    if (!request.user) {
      return reply.status(401).send({ error: 'Authentication required.' });
    }

    try {
      // Parse and validate query parameters
      const queryParams = request.query as Record<string, string | undefined>;
      const limit = Math.min(Math.max(parseInt(queryParams.limit ?? '') || 50, 1), 100);
      const offset = Math.max(parseInt(queryParams.offset ?? '') || 0, 0);
      const sortableColumns = ['createdAt', 'updatedAt', 'status'] as const;
      type SortableColumn = typeof sortableColumns[number];
      const rawSortBy = queryParams.sortBy;
      const sortBy: SortableColumn = (sortableColumns as readonly string[]).includes(rawSortBy ?? '')
        ? (rawSortBy as SortableColumn)
        : 'createdAt';
      const sortOrder = queryParams.sortOrder === 'asc' ? 'asc' : 'desc';
      const statusFilter = queryParams.status && ['processing', 'completed', 'partly_completed', 'failed', 'duplicate'].includes(queryParams.status)
        ? queryParams.status
        : null;

      // Build base query conditions



      // Get total count for pagination
      const [{ totalCount }] = await db
        .select({ totalCount: count() })
        .from(receiptUploads)
        .where(statusFilter 
          ? sql`${receiptUploads.userId} = ${request.user.id} AND ${receiptUploads.status} = ${statusFilter}`
          : eq(receiptUploads.userId, request.user.id)
        );

      // Fetch uploads with aggregated receipt statistics using a single optimized query
      const uploadsWithStats = await db
        .select({
          uploadId: receiptUploads.id,
          uploadNumber: receiptUploads.uploadNumber,
          originalImageUrl: receiptUploads.originalImageUrl,
          markedImageUrl: receiptUploads.markedImageUrl,
          originalFileName: receiptUploads.originalFileName,
          status: receiptUploads.status,
          hasReceipts: receiptUploads.hasReceipts,
          createdAt: receiptUploads.createdAt,
          updatedAt: receiptUploads.updatedAt,
          totalReceipts: sql<number>`COALESCE(SUM(CASE WHEN ${receipts.deletedAt} IS NULL THEN 1 ELSE 0 END), 0)`,
          successfulReceipts: sql<number>`COALESCE(SUM(CASE WHEN ${receipts.status} = 'processed' AND ${receipts.deletedAt} IS NULL THEN 1 ELSE 0 END), 0)`,
          failedReceipts: sql<number>`COALESCE(SUM(CASE WHEN ${receipts.status} IN ('failed', 'unreadable') AND ${receipts.deletedAt} IS NULL THEN 1 ELSE 0 END), 0)`,
          processingReceipts: sql<number>`COALESCE(SUM(CASE WHEN ${receipts.status} = 'pending' AND ${receipts.deletedAt} IS NULL THEN 1 ELSE 0 END), 0)`,
          needsReviewReceipts: sql<number>`COALESCE(SUM(CASE WHEN ${receipts.reviewStatus} = 'needs_review' AND ${receipts.deletedAt} IS NULL THEN 1 ELSE 0 END), 0)`,
          editedReceipts: sql<number>`COALESCE(SUM(CASE WHEN ${receipts.editedAt} IS NOT NULL AND ${receipts.deletedAt} IS NULL THEN 1 ELSE 0 END), 0)`,
          rateLimitedReceipts: sql<number>`COALESCE(SUM(CASE WHEN ${receipts.status} = 'rate_limited' AND ${receipts.deletedAt} IS NULL THEN 1 ELSE 0 END), 0)`,
          totalValue: sql<string>`COALESCE(SUM(CASE WHEN ${receipts.deletedAt} IS NULL AND ${receipts.totalAmount} IS NOT NULL THEN ${receipts.totalAmount} ELSE 0 END), 0)`,
          currencyCount: sql<number>`COUNT(DISTINCT CASE WHEN ${receipts.deletedAt} IS NULL AND ${receipts.currency} IS NOT NULL THEN ${receipts.currency} END)`,
          primaryCurrency: sql<string>`MIN(CASE WHEN ${receipts.deletedAt} IS NULL AND ${receipts.currency} IS NOT NULL THEN ${receipts.currency} END)`,
        })
        .from(receiptUploads)
        .leftJoin(receipts, eq(receipts.uploadId, receiptUploads.id))
        .where(statusFilter 
          ? sql`${receiptUploads.userId} = ${request.user.id} AND ${receiptUploads.status} = ${statusFilter}`
          : eq(receiptUploads.userId, request.user.id)
        )
        .groupBy(receiptUploads.id)
        .orderBy(
          sortOrder === 'asc'
            ? asc(receiptUploads[sortBy])
            : desc(receiptUploads[sortBy])
        )
        .limit(limit)
        .offset(offset);

      // Format response
      const formattedUploads = uploadsWithStats.map(upload => {
        // Prefer original filename saved at upload time; fall back to URL-derived name
        const urlParts = upload.originalImageUrl.split('/');
        const urlFileName = urlParts[urlParts.length - 1] || 'unknown.jpg';
        const fileName = upload.originalFileName || urlFileName;

        return {
          uploadId: upload.uploadId,
          uploadNumber: upload.uploadNumber,
          fileName: fileName,
          status: upload.status,
          hasReceipts: upload.hasReceipts === 1,
          createdAt: upload.createdAt,
          updatedAt: upload.updatedAt,
          statistics: {
            totalDetected: Number(upload.totalReceipts),
            successful: Number(upload.successfulReceipts),
            failed: Number(upload.failedReceipts),
            processing: Number(upload.processingReceipts),
            needsReview: Number(upload.needsReviewReceipts),
            edited: Number(upload.editedReceipts),
            rateLimited: Number(upload.rateLimitedReceipts),
            totalValue: Number(upload.totalValue).toFixed(2),
            currency: Number(upload.currencyCount) === 1 ? (upload.primaryCurrency ?? null) : null,
            mixedCurrencies: Number(upload.currencyCount) > 1,
          },
          images: {
            original: upload.originalImageUrl,
            marked: upload.markedImageUrl || null,
          },
        };
      });

      // Send response with pagination metadata
      reply.send({
        uploads: formattedUploads,
        pagination: {
          total: totalCount,
          limit: limit,
          offset: offset,
          hasMore: offset + limit < totalCount,
        },
      });

    } catch (error: any) {
      request.log.error({ err: error }, 'Failed to fetch user uploads');
      reply.status(500).send({ error: 'Could not fetch uploads.', details: error.message });
    }
  });

  // --- Delete All User Data ---
  server.delete('/users/me/data', { preHandler: [authenticate] }, async (request, reply) => {
    if (!request.user) {
      return reply.status(401).send({ error: 'Authentication required.' });
    }

    const userId = request.user.id;

    try {
      request.log.info(`User ${userId} requested complete data deletion`);

      // 1. Get all uploads for this user to collect image file paths
      const userUploads = await db
        .select({
          id: receiptUploads.id,
          originalImageUrl: receiptUploads.originalImageUrl,
          markedImageUrl: receiptUploads.markedImageUrl,
        })
        .from(receiptUploads)
        .where(eq(receiptUploads.userId, userId));

      if (userUploads.length === 0) {
        return reply.send({
          message: 'No data found to delete.',
          deletedCounts: {
            uploads: 0,
            receipts: 0,
            lineItems: 0,
            errors: 0,
            duplicateMatches: 0,
            files: 0,
          },
        });
      }

      const uploadIds = userUploads.map(u => u.id);

      // 2. Get all receipts for these uploads to collect receipt image paths
      const userReceipts = await db
        .select({
          id: receipts.id,
          imageUrl: receipts.imageUrl,
        })
        .from(receipts)
        .where(inArray(receipts.uploadId, uploadIds));

      const receiptIds = userReceipts.map(r => r.id);

      // 3. Collect all file paths to delete
      const filesToDelete: string[] = [];
      const __filename = fileURLToPath(import.meta.url);
      const __dirname = path.dirname(__filename);
      const uploadsDir = path.join(__dirname, '../../../uploads');

      // Add upload images (original and marked)
      for (const upload of userUploads) {
        if (upload.originalImageUrl) {
          const filename = upload.originalImageUrl.split('/').pop();
          if (filename) filesToDelete.push(path.join(uploadsDir, filename));
        }
        if (upload.markedImageUrl) {
          const filename = upload.markedImageUrl.split('/').pop();
          if (filename) filesToDelete.push(path.join(uploadsDir, filename));
        }
      }

      // Add receipt images
      for (const receipt of userReceipts) {
        if (receipt.imageUrl) {
          const filename = receipt.imageUrl.split('/').pop();
          if (filename) filesToDelete.push(path.join(uploadsDir, filename));
        }
      }

      // 4. Delete database records (in correct order to respect foreign keys)
      let deletedCounts = {
        uploads: 0,
        receipts: 0,
        lineItems: 0,
        errors: 0,
        duplicateMatches: 0,
        files: 0,
      };

      if (receiptIds.length > 0) {
        const lineItemsResult = await db.delete(lineItems).where(inArray(lineItems.receiptId, receiptIds));
        deletedCounts.lineItems = lineItemsResult[0].affectedRows || 0;

        const duplicateMatchesResult = await db.delete(duplicateMatches).where(
          or(
            inArray(duplicateMatches.receiptId, receiptIds),
            inArray(duplicateMatches.potentialDuplicateId, receiptIds)
          )
        );
        deletedCounts.duplicateMatches = duplicateMatchesResult[0].affectedRows || 0;
      }

      if (uploadIds.length > 0) {
        const errorsResult = await db.delete(processingErrors).where(inArray(processingErrors.uploadId, uploadIds));
        deletedCounts.errors = errorsResult[0].affectedRows || 0;

        const receiptsResult = await db.delete(receipts).where(inArray(receipts.uploadId, uploadIds));
        deletedCounts.receipts = receiptsResult[0].affectedRows || 0;

        const uploadsResult = await db.delete(receiptUploads).where(eq(receiptUploads.userId, userId));
        deletedCounts.uploads = uploadsResult[0].affectedRows || 0;
      }

      // 5. Delete physical files from disk
      for (const filePath of filesToDelete) {
        try {
          await fs.unlink(filePath);
          deletedCounts.files++;
          request.log.info(`Deleted file: ${filePath}`);
        } catch (err: any) {
          // File might not exist or already deleted - log but don't fail
          if (err.code !== 'ENOENT') {
            request.log.warn(`Failed to delete file ${filePath}: ${err.message}`);
          }
        }
      }

      request.log.info({ details: deletedCounts }, `User ${userId} data deletion completed`);

      return reply.send({
        message: 'All your data has been successfully deleted.',
        deletedCounts,
      });

    } catch (error: any) {
      request.log.error({ err: error }, 'Failed to delete user data');
      return reply.status(500).send({ 
        error: 'Failed to delete user data.', 
        details: error.message 
      });
    }
  });

  async function getUserExportOptions(userId: number): Promise<ExportOptions> {
    const [user] = await db.select({ exportSettings: users.exportSettings }).from(users).where(eq(users.id, userId));
    return { ...DEFAULT_EXPORT_OPTIONS, ...(user?.exportSettings ?? {}) };
  }

  // Route to export receipt summaries as CSV (no line items)
  server.get('/users/me/receipts/export-csv', { preHandler: [authenticate] }, async (request, reply) => {
    if (!request.user) return reply.status(401).send({ error: 'Authentication required.' });

    try {
      const opts = await getUserExportOptions(request.user.id);
      const userUploads = await db.select({ id: receiptUploads.id }).from(receiptUploads).where(eq(receiptUploads.userId, request.user.id));

      if (userUploads.length === 0) return reply.status(404).send({ message: 'No receipt uploads found for this user.' });

      const uploadIds = userUploads.map(u => u.id);
      const userReceipts: CsvReceipt[] = await db.query.receipts.findMany({
        where: inArray(receipts.uploadId, uploadIds),
        with: { lineItems: true },
      });

      if (!userReceipts?.length) return reply.status(404).send({ message: 'No processed receipts found for this user.' });

      const csv = generateReceiptsCsv(userReceipts, opts);
      reply.header('Content-Type', 'text/csv');
      reply.header('Content-Disposition', `attachment; filename="receipts_export.csv"`);
      reply.send(csv);
    } catch (error) {
      request.log.error({ err: error }, 'Failed to export user receipts to CSV');
      reply.status(500).send({ error: 'Could not export receipts to CSV.', details: error });
    }
  });

  // Route to export all line items as CSV
  server.get('/users/me/items/export-csv', { preHandler: [authenticate] }, async (request, reply) => {
    if (!request.user) return reply.status(401).send({ error: 'Authentication required.' });

    try {
      const opts = await getUserExportOptions(request.user.id);
      const userUploads = await db.select({ id: receiptUploads.id }).from(receiptUploads).where(eq(receiptUploads.userId, request.user.id));

      if (userUploads.length === 0) return reply.status(404).send({ message: 'No uploads found for this user.' });

      const uploadIds = userUploads.map(u => u.id);
      const userReceipts: CsvReceipt[] = await db.query.receipts.findMany({ where: inArray(receipts.uploadId, uploadIds), with: { lineItems: true } });

      if (!userReceipts?.length) return reply.status(404).send({ message: 'No receipts found for this user.' });

      const csv = generateItemsCsv(userReceipts, opts);
      if (!csv) return reply.status(404).send({ message: 'No line items found for this user.' });

      reply.header('Content-Type', 'text/csv');
      reply.header('Content-Disposition', `attachment; filename="items_export.csv"`);
      reply.send(csv);
    } catch (error) {
      request.log.error({ err: error }, 'Failed to export user items to CSV');
      reply.status(500).send({ error: 'Could not export items to CSV.', details: error });
    }
  });

  // Route to export all uploads as CSV
  server.get('/users/me/uploads/export-csv', { preHandler: [authenticate] }, async (request, reply) => {
    if (!request.user) {
      return reply.status(401).send({ error: 'Authentication required.' });
    }

    try {
      const uploadsWithStats = await db
        .select({
          uploadId: receiptUploads.id,
          originalImageUrl: receiptUploads.originalImageUrl,
          status: receiptUploads.status,
          createdAt: receiptUploads.createdAt,
          updatedAt: receiptUploads.updatedAt,
          totalReceipts: sql<number>`COALESCE(COUNT(${receipts.id}), 0)`,
          successfulReceipts: sql<number>`COALESCE(SUM(CASE WHEN ${receipts.status} = 'processed' THEN 1 ELSE 0 END), 0)`,
          failedReceipts: sql<number>`COALESCE(SUM(CASE WHEN ${receipts.status} IN ('failed', 'unreadable') THEN 1 ELSE 0 END), 0)`,
          processingReceipts: sql<number>`COALESCE(SUM(CASE WHEN ${receipts.status} = 'pending' THEN 1 ELSE 0 END), 0)`,
        })
        .from(receiptUploads)
        .leftJoin(receipts, eq(receipts.uploadId, receiptUploads.id))
        .where(eq(receiptUploads.userId, request.user.id))
        .groupBy(receiptUploads.id)
        .orderBy(desc(receiptUploads.createdAt));

      if (uploadsWithStats.length === 0) {
        return reply.status(404).send({ message: 'No uploads found for this user.' });
      }

      const uploads = uploadsWithStats.map(u => {
        const urlParts = u.originalImageUrl.split('/');
        const fileName = urlParts[urlParts.length - 1] || 'unknown.jpg';
        return {
          uploadId: u.uploadId,
          fileName,
          status: u.status,
          createdAt: u.createdAt,
          updatedAt: u.updatedAt,
          statistics: {
            totalDetected: Number(u.totalReceipts),
            successful: Number(u.successfulReceipts),
            failed: Number(u.failedReceipts),
            processing: Number(u.processingReceipts),
          },
        };
      });

      const opts = await getUserExportOptions(request.user.id);
      const csv = generateUploadsCsv(uploads, opts);

      reply.header('Content-Type', 'text/csv');
      reply.header('Content-Disposition', `attachment; filename="uploads_export.csv"`);
      reply.send(csv);

    } catch (error) {
      request.log.error({ err: error }, 'Failed to export user uploads to CSV');
      reply.status(500).send({ error: 'Could not export uploads to CSV.', details: error });
    }
  });

  // GET storage stats — how many original files are stored and eligible for cleanup
  server.get('/users/me/storage/stats', { preHandler: [authenticate] }, async (request, reply) => {
    if (!request.user) return reply.status(401).send({ error: 'User not authenticated.' });

    const uploads = await db
      .select({ status: receiptUploads.status, rawImageUrl: receiptUploads.rawImageUrl })
      .from(receiptUploads)
      .where(eq(receiptUploads.userId, request.user.id));

    const originalsStored = uploads.filter(u => u.rawImageUrl !== null).length;
    const cleanupEligible = uploads.filter(
      u => u.rawImageUrl !== null && (u.status === 'completed' || u.status === 'partly_completed')
    ).length;

    return reply.send({ originalsStored, cleanupEligible });
  });

  // POST cleanup — delete raw original files for successfully processed uploads
  server.post('/users/me/storage/cleanup-originals', { preHandler: [authenticate] }, async (request, reply) => {
    if (!request.user) return reply.status(401).send({ error: 'User not authenticated.' });

    const allUploads = await db
      .select({ id: receiptUploads.id, rawImageUrl: receiptUploads.rawImageUrl, status: receiptUploads.status })
      .from(receiptUploads)
      .where(eq(receiptUploads.userId, request.user.id));

    const toClean = allUploads.filter(
      u => u.rawImageUrl && (u.status === 'completed' || u.status === 'partly_completed')
    );

    let deletedCount = 0;
    for (const upload of toClean) {
      try {
        await deleteFile(upload.rawImageUrl!);
        await db.update(receiptUploads)
          .set({ rawImageUrl: null })
          .where(eq(receiptUploads.id, upload.id));
        deletedCount++;
      } catch (err) {
        request.log.warn({ err, uploadId: upload.id }, 'Failed to delete raw image during cleanup');
      }
    }

    return reply.send({ deletedCount, message: `Cleaned up ${deletedCount} original file(s).` });
  });

  // GET current user settings
  server.get('/users/me/settings', { preHandler: [authenticate] }, async (request, reply) => {
    if (!request.user) return reply.status(401).send({ error: 'User not authenticated.' });

    const [user] = await db
      .select({ autoResumeRateLimited: users.autoResumeRateLimited, exportSettings: users.exportSettings })
      .from(users)
      .where(eq(users.id, request.user.id));

    if (!user) return reply.status(404).send({ error: 'User not found.' });

    return reply.send({
      autoResumeRateLimited: user.autoResumeRateLimited,
      exportSettings: { ...DEFAULT_EXPORT_OPTIONS, ...(user.exportSettings ?? {}) },
    });
  });

  // PATCH user settings
  server.patch('/users/me/settings', { preHandler: [authenticate] }, async (request, reply) => {
    if (!request.user) return reply.status(401).send({ error: 'User not authenticated.' });

    const body = request.body as { autoResumeRateLimited?: boolean; exportSettings?: Partial<ExportOptions> };
    const updateSet: Record<string, unknown> = {};

    if (typeof body.autoResumeRateLimited === 'boolean') {
      updateSet.autoResumeRateLimited = body.autoResumeRateLimited;
    }

    if (body.exportSettings && typeof body.exportSettings === 'object') {
      // Read current settings and merge
      const [current] = await db.select({ exportSettings: users.exportSettings }).from(users).where(eq(users.id, request.user.id));
      updateSet.exportSettings = { ...DEFAULT_EXPORT_OPTIONS, ...(current?.exportSettings ?? {}), ...body.exportSettings };
    }

    if (Object.keys(updateSet).length === 0) {
      return reply.status(400).send({ error: 'Invalid settings payload.' });
    }

    await db.update(users).set(updateSet).where(eq(users.id, request.user.id));

    const [updated] = await db
      .select({ autoResumeRateLimited: users.autoResumeRateLimited, exportSettings: users.exportSettings })
      .from(users)
      .where(eq(users.id, request.user.id));

    return reply.send({
      autoResumeRateLimited: updated.autoResumeRateLimited,
      exportSettings: { ...DEFAULT_EXPORT_OPTIONS, ...(updated.exportSettings ?? {}) },
    });
  });
}
import { randomBytes } from 'crypto';
import { FastifyInstance } from 'fastify';
import { db, users, receiptUploads, receipts } from '../../db/index.js';
import { eq, inArray, desc, asc, sql, count } from 'drizzle-orm';
import { authenticate } from '../auth.js';
import { generateReceiptsCsv } from '../../services/csvGenerator.js';
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

// Define a placeholder type that matches what generateReceiptsCsv expects.
type Receipt = any;

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
      request.log.error(error, 'Failed to create new user');
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
      request.log.error(error, 'Login failed');
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
      const queryParams = request.query as any;
      const limit = Math.min(Math.max(parseInt(queryParams.limit) || 50, 1), 100);
      const offset = Math.max(parseInt(queryParams.offset) || 0, 0);
      const sortBy = ['createdAt', 'updatedAt', 'status'].includes(queryParams.sortBy) 
        ? queryParams.sortBy 
        : 'createdAt';
      const sortOrder = queryParams.sortOrder === 'asc' ? 'asc' : 'desc';
      const statusFilter = queryParams.status && ['processing', 'completed', 'partly_completed', 'failed'].includes(queryParams.status)
        ? queryParams.status
        : null;

      // Build base query conditions
      let whereConditions = eq(receiptUploads.userId, request.user.id);
      if (statusFilter) {
        whereConditions = sql`${receiptUploads.userId} = ${request.user.id} AND ${receiptUploads.status} = ${statusFilter}`;
      }

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
          originalImageUrl: receiptUploads.originalImageUrl,
          markedImageUrl: receiptUploads.markedImageUrl,
          status: receiptUploads.status,
          hasReceipts: receiptUploads.hasReceipts,
          createdAt: receiptUploads.createdAt,
          updatedAt: receiptUploads.updatedAt,
          totalReceipts: sql<number>`COALESCE(COUNT(${receipts.id}), 0)`,
          successfulReceipts: sql<number>`COALESCE(SUM(CASE WHEN ${receipts.status} = 'processed' THEN 1 ELSE 0 END), 0)`,
          failedReceipts: sql<number>`COALESCE(SUM(CASE WHEN ${receipts.status} IN ('failed', 'unreadable') THEN 1 ELSE 0 END), 0)`,
          processingReceipts: sql<number>`COALESCE(SUM(CASE WHEN ${receipts.status} = 'pending' THEN 1 ELSE 0 END), 0)`,
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
            ? asc(receiptUploads[sortBy as keyof typeof receiptUploads])
            : desc(receiptUploads[sortBy as keyof typeof receiptUploads])
        )
        .limit(limit)
        .offset(offset);

      // Format response
      const formattedUploads = uploadsWithStats.map(upload => {
        // Extract filename from URL
        const urlParts = upload.originalImageUrl.split('/');
        const fileName = urlParts[urlParts.length - 1] || 'unknown.jpg';

        return {
          uploadId: upload.uploadId,
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
      request.log.error(error, 'Failed to fetch user uploads');
      reply.status(500).send({ error: 'Could not fetch uploads.', details: error.message });
    }
  });

  // Route to export all receipt data for the authenticated user as CSV
  server.get('/users/me/receipts/export-csv', { preHandler: [authenticate] }, async (request, reply) => {
    if (!request.user) {
      return reply.status(401).send({ error: 'Authentication required.' });
    }

    try {
      // Step 1: Find all upload IDs for the current user
      const userUploads = await db.select({ id: receiptUploads.id }).from(receiptUploads).where(eq(receiptUploads.userId, request.user.id));
      
      if (userUploads.length === 0) {
        return reply.status(404).send({ message: 'No receipt uploads found for this user.' });
      }

      const uploadIds = userUploads.map(u => u.id);

      // Step 2: Fetch all receipts associated with those upload IDs, along with their line items
      const userReceipts: Receipt[] = await db.query.receipts.findMany({
        where: inArray(receipts.uploadId, uploadIds),
        with: {
          lineItems: true,
        },
      });

      if (!userReceipts || userReceipts.length === 0) {
        return reply.status(404).send({ message: 'No processed receipts found for this user.' });
      }

      // Generate CSV from the fetched data
      const csv = generateReceiptsCsv(userReceipts);

      reply.header('Content-Type', 'text/csv');
      reply.header('Content-Disposition', `attachment; filename="user_${request.user.id}_receipts_export.csv"`);
      reply.send(csv);

    } catch (error) {
      request.log.error(error, 'Failed to export user receipts to CSV');
      reply.status(500).send({ error: 'Could not export receipts to CSV.', details: error });
    }
  });
}
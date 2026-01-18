import { randomBytes } from 'crypto';
import { FastifyInstance } from 'fastify';
import { db, users, receiptUploads, receipts } from '../../db/index.js';
import { eq, inArray } from 'drizzle-orm';
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
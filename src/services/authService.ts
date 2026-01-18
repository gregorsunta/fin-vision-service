import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import { db, users } from '../db/index.js';
import { eq } from 'drizzle-orm';

// --- Environment Variables ---
const JWT_SECRET = process.env.JWT_SECRET;
const REFRESH_TOKEN_SECRET = process.env.REFRESH_TOKEN_SECRET;

if (!JWT_SECRET || !REFRESH_TOKEN_SECRET) {
  throw new Error('JWT_SECRET and REFRESH_TOKEN_SECRET must be set in the environment.');
}

// --- Interfaces ---
export interface UserPayload {
  id: number;
  email: string;
}

// --- Core Functions ---

/**
 * Hashes a password using bcrypt.
 * @param password The plaintext password.
 * @returns A salted and hashed password.
 */
export async function hashPassword(password: string): Promise<string> {
  const saltRounds = 10;
  return bcrypt.hash(password, saltRounds);
}

/**
 * Compares a plaintext password with a hashed password.
 * @param plaintext The plaintext password to check.
 * @param hashed The hashed password from the database.
 * @returns True if the passwords match, false otherwise.
 */
export async function comparePasswords(plaintext: string, hashed: string): Promise<boolean> {
  return bcrypt.compare(plaintext, hashed);
}

/**
 * Generates a short-lived JWT Access Token.
 * @param user The user payload to include in the token.
 * @returns A signed JWT access token.
 */
export function generateAccessToken(user: UserPayload): string {
  return jwt.sign(user, JWT_SECRET!, { expiresIn: '15m' });
}

/**
 * Generates a long-lived JWT Refresh Token and stores it in the database.
 * @param userId The ID of the user for whom to generate the token.
 * @returns A signed JWT refresh token.
 */
export async function generateRefreshToken(userId: number): Promise<string> {
  const refreshToken = jwt.sign({ id: userId }, REFRESH_TOKEN_SECRET!, { expiresIn: '7d' });
  
  // Store the new refresh token in the user's record
  await db.update(users)
    .set({ refreshToken })
    .where(eq(users.id, userId));
    
  return refreshToken;
}

/**
 * Verifies a JWT token.
 * @param token The token to verify.
 * @param secret The secret key to use for verification.
 * @returns The decoded payload if the token is valid, otherwise throws an error.
 */
export function verifyToken<T>(token: string, secret: string): T {
  return jwt.verify(token, secret) as T;
}

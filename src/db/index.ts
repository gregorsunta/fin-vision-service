import 'dotenv/config';
import { drizzle } from 'drizzle-orm/mysql2';
import mysql from 'mysql2/promise';
import * as schema from './schema.js';

if (!process.env.DATABASE_URL) {
  throw new Error('DATABASE_URL is not set in the environment variables');
}

export const poolConnection = mysql.createPool(process.env.DATABASE_URL);

export const db = drizzle(poolConnection, { schema, mode: 'default' });
export * from './schema.js';

import 'dotenv/config';
import { drizzle } from 'drizzle-orm/mysql2';
import mysql from 'mysql2/promise';
import * as schema from './schema.js';

if (!process.env.DATABASE_URL) {
  throw new Error('DATABASE_URL is not set in the environment variables');
}

let connectionString = process.env.DATABASE_URL;
if (process.env.NODE_ENV === 'development') {
  // In development, replace the Docker service hostname with localhost:3307
  connectionString = connectionString.replace('@mysql:3306', '@localhost:3307');
}

export const poolConnection = mysql.createPool(connectionString);

export const db = drizzle(poolConnection, { schema, mode: 'default' });

export * from './schema.js';

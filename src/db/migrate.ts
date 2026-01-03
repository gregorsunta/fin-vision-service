import 'dotenv/config';
import { migrate } from 'drizzle-orm/mysql2/migrator';
import { db, poolConnection } from './index.js';
import path from 'path';
import { fileURLToPath } from 'url';

// Replicate __dirname functionality in ES Modules
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function runMigrations() {
  console.log('Running database migrations...');
  
  const migrationsFolder = path.join(__dirname, '../../drizzle');
  
  try {
    await migrate(db, { migrationsFolder });
    console.log('Migrations applied successfully!');
  } catch (error) {
    console.error('Error applying migrations:', error);
    process.exit(1);
  } finally {
    // End the pool connection to allow the script to exit
    await poolConnection.end();
  }
}

runMigrations();

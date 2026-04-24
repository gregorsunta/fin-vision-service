import 'dotenv/config';
import { migrate } from 'drizzle-orm/mysql2/migrator';
import { db, poolConnection } from './index.js';
import { createLogger } from '../utils/logger.js';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const log = createLogger('db.migrate');

async function runMigrations() {
  log.info('running database migrations');

  const migrationsFolder = path.join(__dirname, '../../drizzle');

  try {
    await migrate(db, { migrationsFolder });
    log.info('migrations applied successfully');
  } catch (error) {
    log.error({ err: error }, 'error applying migrations');
    process.exit(1);
  } finally {
    await poolConnection.end();
  }
}

runMigrations();

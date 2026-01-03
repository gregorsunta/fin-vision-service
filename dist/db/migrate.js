import 'dotenv/config';
import { migrate } from 'drizzle-orm/mysql2/migrator';
import { db } from './index';
import { poolConnection } from './index';
import path from 'path';
async function runMigrations() {
    console.log('Running database migrations...');
    const migrationsFolder = path.join(__dirname, '../../drizzle');
    try {
        await migrate(db, { migrationsFolder });
        console.log('Migrations applied successfully!');
    }
    catch (error) {
        console.error('Error applying migrations:', error);
        process.exit(1);
    }
    finally {
        // End the pool connection to allow the script to exit
        await poolConnection.end();
    }
}
runMigrations();

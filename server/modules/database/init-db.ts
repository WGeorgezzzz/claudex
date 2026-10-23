import { initializeOwnership, registerOwnershipContext } from './ownership.js';
import { getConnection } from "@/modules/database/connection.js";
import { runMigrations } from "@/modules/database/migrations.js";
import { INIT_SCHEMA_SQL } from "@/modules/database/schema.js";
import { initializeDotTables } from '@/modules/database/repositories/dot.db.js';
import { initializeAuthSessionTables } from '@/modules/database/repositories/auth-sessions.db.js';

// Initialize database with schema
export const initializeDatabase = async () => {
    try {
        const db = getConnection();
        registerOwnershipContext(db);
        db.exec(INIT_SCHEMA_SQL);
        console.log('Database schema applied');
        runMigrations(db);
        initializeDotTables(db);
        initializeAuthSessionTables(db);
        initializeOwnership(db);
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.log('Database initialization failed', { error: message });
        throw err;
    }
};

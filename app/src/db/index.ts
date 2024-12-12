
import { Pool } from 'pg';

export const pool = new Pool({
    connectionString: process.env.CONNECTION,
    max: 100,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 3000,
});
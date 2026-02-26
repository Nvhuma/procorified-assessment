require('dotenv').config();

/**
 * db.js
 * Shared PostgreSQL connection pool.
 *
 * Credentials are read from environment variables loaded by dotenv.
 * Defaults are for local development only - production must supply
 * explicit env vars.
 *
 * Why a shared pool: creating a new connection per request is expensive.
 * The pool reuses existing connections and queues requests under load,
 * which is the correct pattern for a Node.js backend.
 */

const { Pool } = require('pg');
const { logError } = require('./logger');

const pool = new Pool({
  host: process.env.DB_HOST || 'localhost',
  port: Number(process.env.DB_PORT) || 5432,
  database: process.env.DB_NAME || 'procurifieddb',
  user: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASSWORD || '',
});

// Surface unexpected pool-level errors (e.g. dropped connections) through
// the structured logger rather than letting them crash the process silently.
pool.on('error', (err) => {
  logError('db.pool.error', { error: err.message });
});

// Single shared pool across all modules.
// Caller is responsible for calling pool.end() in CLI scripts and tests.
module.exports = pool;

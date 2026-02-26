require('dotenv').config();

/**
 * db.js
 * PostgreSQL connection pool.
 * Uses environment variables so credentials are never hardcoded.
 */

const { Pool } = require('pg');
const { logError } = require('./logger');

function parseBooleanFlag(value) {
  if (value === undefined || value === null) {
    return false;
  }

  const normalized = String(value).trim().toLowerCase();
  return normalized === 'true' || normalized === '1' || normalized === 'yes';
}

const strictConfig = parseBooleanFlag(process.env.DB_STRICT_CONFIG);

if (strictConfig) {
  const requiredNonEmpty = ['DB_HOST', 'DB_PORT', 'DB_NAME', 'DB_USER'];
  const missingOrEmpty = requiredNonEmpty.filter((key) => {
    const value = process.env[key];
    return value === undefined || value.trim() === '';
  });

  if (missingOrEmpty.length > 0) {
    throw new Error(
      `DB_STRICT_CONFIG is enabled but missing/empty required env vars: ${missingOrEmpty.join(', ')}`
    );
  }

  // DB_PASSWORD must be present but may be empty for local setups.
  if (process.env.DB_PASSWORD === undefined) {
    throw new Error('DB_STRICT_CONFIG is enabled but missing required env var: DB_PASSWORD');
  }
}

const resolvedPortRaw = strictConfig
  ? process.env.DB_PORT
  : (process.env.DB_PORT || '5432');
const resolvedPort = Number(resolvedPortRaw);
if (!Number.isInteger(resolvedPort) || resolvedPort <= 0) {
  throw new Error(`DB_PORT must be a positive integer, received: ${resolvedPortRaw}`);
}

const resolvedHost = strictConfig
  ? process.env.DB_HOST
  : (process.env.DB_HOST || 'localhost');
const resolvedDatabase = strictConfig
  ? process.env.DB_NAME
  : (process.env.DB_NAME || 'procurifieddb');
const resolvedUser = strictConfig
  ? process.env.DB_USER
  : (process.env.DB_USER || 'postgres');
const resolvedPassword = strictConfig
  ? process.env.DB_PASSWORD
  : (process.env.DB_PASSWORD || '');

const pool = new Pool({
  host: resolvedHost,
  port: resolvedPort,
  database: resolvedDatabase,
  user: resolvedUser,
  password: resolvedPassword,
});

// Single shared pool across modules; caller is responsible for pool.end() in CLI/tests.
pool.on('error', (err) => {
  logError('db.pool.error', { error: err.message });
});

module.exports = pool;

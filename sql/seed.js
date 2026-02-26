/**
 * seed.js
 * Creates required tables and inserts deterministic sample data.
 * Run with: node sql/seed.js
 */

const pool = require('../src/db');
const { logInfo, logError } = require('../src/logger');
const { resetDatabase } = require('./bootstrap');

async function seed() {
  let client;

  try {
    client = await pool.connect();
    await client.query('BEGIN');
    await resetDatabase(client);
    await client.query('COMMIT');
    logInfo('db.seed.success');
    console.log('Seed complete.');
  } catch (err) {
    if (client) {
      await client.query('ROLLBACK');
    }
    logError('db.seed.failed', { error: err.message });
    throw err;
  } finally {
    if (client) {
      client.release();
    }
  }
}

seed()
  .catch((err) => {
    console.error('Seed failed:', err.message);
    process.exitCode = 1;
  })
  .finally(async () => {
    await pool.end();
  });

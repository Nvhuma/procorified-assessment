/**
 * tests/index.test.js
 *
 * Lightweight test runner with:
 * - Unit tests (no DB)
 * - Integration tests (requires seeded PostgreSQL)
 */

// Suppress expected error logs from negative-path unit tests.
process.env.LOG_LEVEL = process.env.LOG_LEVEL || 'silent';

const {
  extractJsonSnippets,
  buildEvaluableExpression,
  evaluateExpression,
} = require('../src/calculations');

let passed = 0;
let failed = 0;

function assert(description, fn) {
  try {
    fn();
    console.log(`  PASS ${description}`);
    passed++;
  } catch (err) {
    console.error(`  FAIL ${description}`);
    console.error(`       ${err.message}`);
    failed++;
  }
}

function assertEqual(actual, expected, label = '') {
  const actualSerialized = JSON.stringify(actual);
  const expectedSerialized = JSON.stringify(expected);
  if (actualSerialized !== expectedSerialized) {
    throw new Error(
      `${label ? `${label}: ` : ''}Expected ${expectedSerialized}, got ${actualSerialized}`
    );
  }
}

function normalizeNumericString(value) {
  // Normalize DB NUMERIC text for stable string equality assertions in tests.
  const raw = String(value).trim();
  if (!/^-?\d+(?:\.\d+)?$/.test(raw)) {
    return raw;
  }

  const normalized = raw.includes('.')
    ? raw.replace(/(\.\d*?[1-9])0+$/, '$1').replace(/\.0+$/, '')
    : raw;
  return normalized === '-0' ? '0' : normalized;
}

function assertThrows(fn, messageFragment) {
  try {
    fn();
    throw new Error('Expected function to throw but it did not');
  } catch (err) {
    if (messageFragment && !err.message.includes(messageFragment)) {
      throw new Error(
        `Expected error containing "${messageFragment}", got "${err.message}"`
      );
    }
  }
}

async function assertRejects(fn, messageFragment) {
  try {
    await fn();
    throw new Error('Expected function to reject but it resolved');
  } catch (err) {
    if (messageFragment && !err.message.includes(messageFragment)) {
      throw new Error(
        `Expected rejection containing "${messageFragment}", got "${err.message}"`
      );
    }
  }
}

console.log('\nUnit Tests\n');

assert('extracts multiple JSON snippets from one expression', () => {
  const snippets = extractJsonSnippets('{ "id": 1 } + { "id": 2 } * 3');
  assertEqual(snippets, ['{ "id": 1 }', '{ "id": 2 }']);
});

assert('throws when expression does not contain a JSON snippet', () => {
  assertThrows(() => extractJsonSnippets('10 + 20'), 'does not contain');
});

assert('builds evaluable expression for multiple snippets', () => {
  const expression = '{ "id": 1 } + { "id": 2 } * 3';
  const evaluable = buildEvaluableExpression(expression, { 1: 2.5, 2: 4 });
  assertEqual(evaluable, '(2.5) + (4) * 3');
});

assert('throws when JSON snippet is invalid', () => {
  assertThrows(
    () => buildEvaluableExpression('{ "id": } + 1', { 1: 10 }),
    'Could not parse JSON snippet'
  );
});

assert('throws when JSON snippet contains nested object instead of top-level id', () => {
  assertThrows(
    () => buildEvaluableExpression('{ "id": 1, "meta": { "x": 1 } } + 1', { 1: 10 }),
    'positive integer "id"'
  );
});

assert('throws when JSON snippet is missing integer id', () => {
  assertThrows(
    () => buildEvaluableExpression('{ "name": "baseRate" } + 1', { 1: 10 }),
    'positive integer "id"'
  );
});

assert('throws when referenced variable value is missing', () => {
  assertThrows(
    () => buildEvaluableExpression('{ "id": 2 } + 1', { 1: 10 }),
    'referenced in expression was not found'
  );
});

assert('evaluates arithmetic expression with precedence', () => {
  const result = evaluateExpression('2.5 + 10 * 2');
  assertEqual(result, '22.5');
});

assert('evaluates decimal arithmetic without floating-point drift', () => {
  const result = evaluateExpression('0.1 + 0.2');
  assertEqual(result, '0.3');
});

assert('throws when arithmetic expression is invalid', () => {
  assertThrows(() => evaluateExpression('2 + * 3'), 'Failed to evaluate expression');
});

assert('rejects unsupported expression tokens', () => {
  assertThrows(
    () => evaluateExpression('sqrt(4)'),
    'Expression contains unsupported tokens'
  );
});

assert('rejects expressions longer than max allowed length', () => {
  const longExpression = `${'1'.repeat(2001)} + 1`;
  assertThrows(
    () => evaluateExpression(longExpression),
    'Expression contains unsupported tokens'
  );
});

const SKIP_INTEGRATION = process.env.DB_SKIP_INTEGRATION === 'true';

async function runIntegrationTests() {
  if (SKIP_INTEGRATION) {
    console.log('\nIntegration tests skipped (DB_SKIP_INTEGRATION=true)\n');
    return;
  }

  console.log('\nIntegration Tests (requires running DB)\n');

  const pool = require('../src/db');
  const { getLineage } = require('../src/lineage');
  const { evaluateCalculation, recalculate } = require('../src/calculations');
  const { resetDatabase } = require('../sql/bootstrap');

  async function reseedDatabase() {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await resetDatabase(client);
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  async function assertAsync(description, fn) {
    try {
      await reseedDatabase();
    } catch (err) {
      throw new Error(`Integration test setup failed before "${description}": ${err.message}`);
    }

    try {
      await fn();
      console.log(`  PASS ${description}`);
      passed++;
    } catch (err) {
      console.error(`  FAIL ${description}`);
      console.error(`       ${err.message}`);
      failed++;
    }
  }

  console.log('  getLineage');

  await assertAsync('returns empty array for root resource', async () => {
    const result = await getLineage(1);
    assertEqual(result, []);
  });

  await assertAsync('returns root-to-parent ordering for deep resource', async () => {
    const result = await getLineage(4);
    assertEqual(result, [1, 2, 3]);
  });

  await assertAsync('throws when resource id does not exist', async () => {
    await assertRejects(() => getLineage(999999), 'not found');
  });

  await assertAsync('stops recursion on cyclic data', async () => {
    const aInsert = await pool.query(
      `INSERT INTO singleresource (name, "parentId") VALUES ('Cycle A', NULL) RETURNING id`
    );
    const aId = aInsert.rows[0].id;

    const bInsert = await pool.query(
      `INSERT INTO singleresource (name, "parentId") VALUES ('Cycle B', $1) RETURNING id`,
      [aId]
    );
    const bId = bInsert.rows[0].id;

    // Create A->B->A to verify recursive lineage detects and rejects cycles.
    await pool.query(`UPDATE singleresource SET "parentId" = $1 WHERE id = $2`, [bId, aId]);

    await assertRejects(() => getLineage(aId), 'Cycle detected');
  });

  console.log('\n  evaluateCalculation');

  await assertAsync('evaluates seeded calculation 1', async () => {
    const { calculatedValue } = await evaluateCalculation(1);
    assertEqual(calculatedValue, '22.5');
  });

  await assertAsync('throws when calculation id does not exist', async () => {
    await assertRejects(() => evaluateCalculation(999999), 'not found');
  });

  await assertAsync('evaluates expression with multiple JSON snippets and persists', async () => {
    const insertResult = await pool.query(
      `INSERT INTO calculations (name, expression, calculated_value)
       VALUES ($1, $2, NULL)
       RETURNING id`,
      [
        'Calc Multi Snippet',
        '{ "id": 1, "name": "baseRate" } + { "id": 2, "name": "multiplier" } * 3',
      ]
    );

    const calculationId = insertResult.rows[0].id;
    const { calculatedValue } = await evaluateCalculation(calculationId);
    assertEqual(calculatedValue, '14.5');

    const persistedResult = await pool.query(
      'SELECT calculated_value FROM calculations WHERE id = $1',
      [calculationId]
    );

    assertEqual(normalizeNumericString(persistedResult.rows[0].calculated_value), '14.5');
  });

  await assertAsync('evaluates large-precision decimal arithmetic and persists exactly', async () => {
    await pool.query(
      `INSERT INTO variables (id, name, value)
       VALUES (200, 'largePrecision', 123456789012.123456)
       ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, value = EXCLUDED.value`
    );

    const insertResult = await pool.query(
      `INSERT INTO calculations (name, expression, calculated_value)
       VALUES ($1, $2, NULL)
       RETURNING id`,
      ['Calc Large Precision', '{ "id": 200, "name": "largePrecision" } + 0.000001']
    );

    const calculationId = insertResult.rows[0].id;
    const { calculatedValue } = await evaluateCalculation(calculationId);
    assertEqual(calculatedValue, '123456789012.123457');

    const persistedResult = await pool.query(
      'SELECT calculated_value FROM calculations WHERE id = $1',
      [calculationId]
    );
    assertEqual(normalizeNumericString(persistedResult.rows[0].calculated_value), '123456789012.123457');
  });

  await assertAsync('returns value rounded to NUMERIC(18,6) scale when needed', async () => {
    await pool.query(
      `INSERT INTO variables (id, name, value)
       VALUES (201, 'needsRounding', 1.123456)
       ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, value = EXCLUDED.value`
    );

    const insertResult = await pool.query(
      `INSERT INTO calculations (name, expression, calculated_value)
       VALUES ($1, $2, NULL)
       RETURNING id`,
      ['Calc Needs Rounding', '{ "id": 201, "name": "needsRounding" } + 0.0000007']
    );

    const calculationId = insertResult.rows[0].id;
    const { calculatedValue } = await evaluateCalculation(calculationId);
    assertEqual(calculatedValue, '1.123457');

    const persistedResult = await pool.query(
      'SELECT calculated_value FROM calculations WHERE id = $1',
      [calculationId]
    );
    assertEqual(normalizeNumericString(persistedResult.rows[0].calculated_value), '1.123457');
  });

  console.log('\n  recalculate');

  await assertAsync(
    'finds whitespace variants and does not match variable id prefixes or scientific notation',
    async () => {
      await pool.query(
        `INSERT INTO variables (id, name, value)
         VALUES (10, 'idTen', 99)
         ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, value = EXCLUDED.value`
      );
      await pool.query(
        `INSERT INTO variables (id, name, value)
         VALUES (100, 'idHundred', 7)
         ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, value = EXCLUDED.value`
      );

      const compactCalc = await pool.query(
        `INSERT INTO calculations (name, expression, calculated_value)
         VALUES ($1, $2, NULL)
         RETURNING id`,
        ['Calc Compact ID', '{"id":1} + 1']
      );
      const compactId = compactCalc.rows[0].id;

      const spacedCalc = await pool.query(
        `INSERT INTO calculations (name, expression, calculated_value)
         VALUES ($1, $2, NULL)
         RETURNING id`,
        ['Calc Spaced ID', '{ "id" : 1, "name": "baseRate" } + 2']
      );
      const spacedId = spacedCalc.rows[0].id;

      const tenCalc = await pool.query(
        `INSERT INTO calculations (name, expression, calculated_value)
         VALUES ($1, $2, NULL)
         RETURNING id`,
        ['Calc ID Ten', '{ "id":10, "name": "idTen" } + 3']
      );
      const tenId = tenCalc.rows[0].id;

      const scientificCalc = await pool.query(
        `INSERT INTO calculations (name, expression, calculated_value)
         VALUES ($1, $2, NULL)
         RETURNING id`,
        ['Calc ID Scientific', '{"id":1e2, "name": "idHundred" } + 3']
      );
      const scientificId = scientificCalc.rows[0].id;

      await pool.query('UPDATE variables SET value = 4.0 WHERE id = 1');

      const results = await recalculate(1);

      const compactResult = results.find((row) => row.calculationId === compactId);
      assertEqual(compactResult?.calculatedValue, '5', 'compact expression');

      const spacedResult = results.find((row) => row.calculationId === spacedId);
      assertEqual(spacedResult?.calculatedValue, '6', 'spaced expression');

      const tenResult = results.find((row) => row.calculationId === tenId);
      if (tenResult) {
        throw new Error('Calculation referencing variable 10 should not match recalculate(1)');
      }

      const scientificResult = results.find((row) => row.calculationId === scientificId);
      if (scientificResult) {
        throw new Error('Calculation referencing variable 1e2 should not match recalculate(1)');
      }
    }
  );

  await assertAsync('returns [] when no calculations reference a variable id', async () => {
    const results = await recalculate(999);
    assertEqual(results, []);
  });

  await assertAsync('atomic recalculate rolls back all updates on failure', async () => {
    const goodCalc = await pool.query(
      `INSERT INTO calculations (name, expression, calculated_value)
       VALUES ($1, $2, NULL)
       RETURNING id`,
      ['Calc Atomic Good', '{ "id": 1 } + 1']
    );
    const goodId = goodCalc.rows[0].id;

    await pool.query(
      `INSERT INTO calculations (name, expression, calculated_value)
       VALUES ($1, $2, NULL)`,
      ['Calc Atomic Bad', '{ "id": 1 } + sqrt(4)']
    );

    await assertRejects(
      () => recalculate(1, { atomic: true }),
      'unsupported tokens'
    );

    const goodValueResult = await pool.query(
      'SELECT calculated_value FROM calculations WHERE id = $1',
      [goodId]
    );
    assertEqual(goodValueResult.rows[0].calculated_value, null, 'good calc should remain untouched');
  });

  await pool.end();
}

runIntegrationTests()
  .catch((err) => {
    console.error('\nUnexpected test runner error:', err);
    process.exit(1);
  })
  .finally(() => {
    console.log('\n---------------------------------');
    console.log(`Results: ${passed} passed, ${failed} failed`);
    if (failed > 0) process.exit(1);
  });

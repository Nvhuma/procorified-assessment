/**
 * Shared schema + seed routine used by both seed script and integration tests.
 * Keeps DB fixtures deterministic and avoids duplication drift.
 */

async function resetDatabase(client) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS singleresource (
      id         SERIAL PRIMARY KEY,
      name       TEXT NOT NULL,
      "parentId" INTEGER REFERENCES singleresource(id)
    );
  `);

  await client.query(`
    CREATE TABLE IF NOT EXISTS variables (
      id    SERIAL PRIMARY KEY,
      name  TEXT NOT NULL,
      value NUMERIC(18, 6) NOT NULL
    );
  `);

  await client.query(`
    CREATE TABLE IF NOT EXISTS calculations (
      id               SERIAL PRIMARY KEY,
      name             TEXT NOT NULL,
      expression       TEXT NOT NULL,
      calculated_value NUMERIC(18, 6)
    );
  `);

  // Ensure existing tables are aligned to NUMERIC types if they were previously FLOAT.
  await client.query(`
    ALTER TABLE variables
    ALTER COLUMN value TYPE NUMERIC(18, 6)
    USING value::NUMERIC;
  `);
  await client.query(`
    ALTER TABLE calculations
    ALTER COLUMN calculated_value TYPE NUMERIC(18, 6)
    USING calculated_value::NUMERIC;
  `);

  await client.query('TRUNCATE singleresource, variables, calculations RESTART IDENTITY CASCADE;');

  await client.query(`
    INSERT INTO singleresource (id, name, "parentId") VALUES
      (1, 'Resource A', NULL),
      (2, 'Resource B', 1),
      (3, 'Resource C', 2),
      (4, 'Resource D', 3),
      (5, 'Resource E', 1);
  `);

  await client.query(`
    INSERT INTO variables (id, name, value) VALUES
      (1, 'baseRate', 2.5),
      (2, 'multiplier', 4.0);
  `);

  await client.query(`
    INSERT INTO calculations (id, name, expression, calculated_value) VALUES
      (1, 'Calc Alpha', '{ "id": 1, "name": "baseRate" } + 10 * 2', NULL),
      (2, 'Calc Beta', '{ "id": 1, "name": "baseRate" } * 3 + 5', NULL),
      (3, 'Calc Gamma', '{ "id": 2, "name": "multiplier" } + 100', NULL);
  `);

  await client.query(`
    SELECT setval(
      pg_get_serial_sequence('singleresource', 'id'),
      COALESCE((SELECT MAX(id) FROM singleresource), 1),
      true
    );
  `);
  await client.query(`
    SELECT setval(
      pg_get_serial_sequence('variables', 'id'),
      COALESCE((SELECT MAX(id) FROM variables), 1),
      true
    );
  `);
  await client.query(`
    SELECT setval(
      pg_get_serial_sequence('calculations', 'id'),
      COALESCE((SELECT MAX(id) FROM calculations), 1),
      true
    );
  `);
}

module.exports = { resetDatabase };

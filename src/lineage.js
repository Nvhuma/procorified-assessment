/**
 * lineage.js
 * Problem 1: Resource lineage query.
 *
 * Returns ancestor IDs from root to immediate parent.
 */

const pool = require('./db');

/**
 * Returns the complete ancestor chain for a given resource, ordered
 * from root (oldest ancestor) to the resource's immediate parent.
 * Returns an empty array if the resource has no parent.
 *
 * @param {number} id - The resource ID to query. Must exist in the database.
 * @returns {Promise<number[]>} Ancestor IDs ordered from root to immediate parent.
 * @throws {TypeError} If id is not a positive integer.
 * @throws {Error}     If no resource with the given id exists.
 * @throws {Error}     If a cycle is detected in the lineage data.
 */
async function getLineage(id) {
  if (!Number.isInteger(id) || id <= 0) {
    throw new TypeError(`id must be a positive integer, received: ${id}`);
  }

  const existsResult = await pool.query(
    'SELECT 1 FROM singleresource WHERE id = $1',
    [id]
  );

  if (existsResult.rows.length === 0) {
    throw new Error(`Resource with id ${id} not found`);
  }

  const query = `
    WITH RECURSIVE ancestors AS (
      SELECT
        id,
        "parentId",
        0 AS depth,
        ARRAY[id] AS path,
        FALSE AS cycle
      FROM singleresource
      WHERE id = $1

      UNION ALL

      SELECT
        r.id,
        r."parentId",
        a.depth + 1 AS depth,
        a.path || r.id,
        r.id = ANY(a.path) AS cycle
      FROM singleresource r
      INNER JOIN ancestors a ON r.id = a."parentId"
      -- Stop expanding a branch once a cycle is detected.
      WHERE NOT a.cycle
    )
    SELECT id, depth, cycle
    FROM ancestors
    ORDER BY depth DESC;
  `;

  const { rows } = await pool.query(query, [id]);

  if (rows.some((row) => row.cycle)) {
    throw new Error(`Cycle detected in resource lineage for id ${id}`);
  }

  return rows
    .filter((row) => row.id !== id)
    .map((row) => row.id);
}

module.exports = { getLineage };

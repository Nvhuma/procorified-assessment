/**
 * calculations.js
 * Problem 2: Expression evaluation and recalculation.
 */

const { create, all } = require('mathjs');
const pool = require('./db');
const { logDebug, logInfo, logError } = require('./logger');

const math = create(all, {
  number: 'BigNumber',
  precision: 64,
});

const JSON_SNIPPET_REGEX = /\{[^{}]+\}/g;
const MAX_EXPRESSION_LENGTH = 2000;

/**
 * Extract all top-level JSON snippets in an expression.
 * Assumes snippets are simple "{...}" blocks with no nested braces.
 *
 * @param {string} expression
 * @returns {string[]}
 */
function extractJsonSnippets(expression) {
  if (typeof expression !== 'string' || expression.trim() === '') {
    throw new TypeError(`expression must be a non-empty string, received: ${expression}`);
  }

  const snippets = expression.match(JSON_SNIPPET_REGEX);
  if (!snippets || snippets.length === 0) {
    throw new Error(`Expression does not contain a JSON snippet: "${expression}"`);
  }

  return snippets;
}

/**
 * Parse one snippet and return the referenced variable ID.
 *
 * @param {string} snippetText
 * @returns {number}
 */
function parseSnippetVariableId(snippetText) {
  let snippet;
  try {
    snippet = JSON.parse(snippetText);
  } catch {
    throw new Error(`Could not parse JSON snippet in expression: "${snippetText}"`);
  }

  if (!Number.isInteger(snippet.id) || snippet.id <= 0) {
    throw new Error(`JSON snippet must contain a positive integer "id" field: ${snippetText}`);
  }

  return snippet.id;
}

/**
 * Normalize a value to a finite BigNumber-backed decimal string.
 *
 * @param {unknown} value
 * @param {string} label
 * @returns {string}
 */
function toBigNumberString(value, label) {
  try {
    const big = math.bignumber(value);
    if (typeof big.isFinite !== 'function' || !big.isFinite()) {
      throw new Error();
    }

    return big.toString();
  } catch {
    throw new Error(`${label} must be a finite numeric value`);
  }
}

/**
 * Replace all JSON snippets in an expression with concrete numeric values.
 *
 * @param {string} expression
 * @param {Record<number, number | string>} valueById
 * @returns {string}
 */
function buildEvaluableExpression(expression, valueById) {
  return expression.replace(JSON_SNIPPET_REGEX, (snippetText) => {
    const variableId = parseSnippetVariableId(snippetText);
    if (!Object.prototype.hasOwnProperty.call(valueById, variableId)) {
      throw new Error(`Variable with id ${variableId} referenced in expression was not found`);
    }

    const variableValue = valueById[variableId];
    const normalizedValue = toBigNumberString(variableValue, `Variable with id ${variableId}`);

    logDebug('calculation.expression.variable_substitute', { variableId });

    // Parenthesize substituted values to preserve intended arithmetic semantics.
    return `(${normalizedValue})`;
  });
}

/**
 * Guards against expressions containing unsupported tokens before they
 * reach mathjs. Although mathjs is safer than eval(), it still accepts
 * function calls such as sqrt() and import() that are outside the intended
 * scope of this feature. This allowlist ensures only plain arithmetic
 * reaches the evaluator, which matters when expression values come from
 * a database field that could be tampered with.
 *
 * Only numbers, parentheses, whitespace, and + - * / are permitted.
 *
 * @param {string} expression
 * @returns {boolean}
 */
function isAllowedArithmeticExpression(expression) {
  if (typeof expression !== 'string') {
    return false;
  }

  const trimmed = expression.trim();
  if (trimmed === '' || trimmed.length > MAX_EXPRESSION_LENGTH) {
    return false;
  }

  let index = 0;
  while (index < expression.length) {
    const remaining = expression.slice(index);

    const whitespaceMatch = remaining.match(/^\s+/);
    if (whitespaceMatch) {
      index += whitespaceMatch[0].length;
      continue;
    }

    const numberMatch = remaining.match(/^(?:\d+(?:\.\d+)?|\.\d+)(?:[eE][+-]?\d+)?/);
    if (numberMatch) {
      index += numberMatch[0].length;
      continue;
    }

    const ch = remaining[0];
    if (ch === '+' || ch === '-' || ch === '*' || ch === '/' || ch === '(' || ch === ')') {
      index += 1;
      continue;
    }

    return false;
  }

  return true;
}

/**
 * Evaluate a plain arithmetic expression using mathjs BigNumber mode.
 *
 * Returns a string rather than a number because mathjs BigNumber results
 * cannot be safely represented as JS floats without precision loss.
 * Callers should treat the return value as a decimal string and pass it
 * directly to PostgreSQL as NUMERIC - do not coerce it to Number first.
 *
 * @param {string} expression
 * @returns {string} Decimal string representation of the result.
 */
function evaluateExpression(expression) {
  if (!isAllowedArithmeticExpression(expression)) {
    throw new Error(
      `Expression contains unsupported tokens. Only numbers, parentheses, and + - * / are allowed: "${expression}"`
    );
  }

  try {
    const result = math.evaluate(expression);
    return toBigNumberString(result, 'Expression result');
  } catch (err) {
    logError('calculation.evaluate_expression.failed', {
      error: err.message,
      expressionLength: expression.length,
    });
    throw new Error(`Failed to evaluate expression "${expression}": ${err.message}`);
  }
}

/**
 * Internal helper used to evaluate a calculation against any queryable
 * interface (pool or transaction client).
 *
 * @param {number} calculationId
 * @param {{ query: Function }} queryable
 * @returns {Promise<{ calculationId: number, calculatedValue: string }>}
 */
async function _evaluateCalculationWithQueryable(calculationId, queryable) {
  try {
    logInfo('calculation.evaluate.start', { calculationId });

    const calcResult = await queryable.query(
      'SELECT id, name, expression FROM calculations WHERE id = $1',
      [calculationId]
    );

    if (calcResult.rows.length === 0) {
      throw new Error(`Calculation with id ${calculationId} not found`);
    }

    const calculation = calcResult.rows[0];
    const snippets = extractJsonSnippets(calculation.expression);
    const referencedVariableIds = [...new Set(snippets.map(parseSnippetVariableId))];

    const variableResult = await queryable.query(
      'SELECT id, value FROM variables WHERE id = ANY($1::int[])',
      [referencedVariableIds]
    );

    const valueById = {};
    for (const variable of variableResult.rows) {
      valueById[variable.id] = variable.value;
    }

    for (const variableId of referencedVariableIds) {
      if (!Object.prototype.hasOwnProperty.call(valueById, variableId)) {
        throw new Error(
          `Variable with id ${variableId} referenced by calculation "${calculation.name}" not found`
        );
      }
    }

    const evaluableExpression = buildEvaluableExpression(calculation.expression, valueById);
    const calculatedValue = evaluateExpression(evaluableExpression);

    const updateResult = await queryable.query(
      'UPDATE calculations SET calculated_value = $1 WHERE id = $2 RETURNING calculated_value',
      [calculatedValue, calculationId]
    );

    if (updateResult.rows.length === 0) {
      throw new Error(`Calculation with id ${calculationId} disappeared during update`);
    }

    // Return the DB value so the function output always matches persisted NUMERIC rounding.
    const persistedCalculatedValue = toBigNumberString(
      updateResult.rows[0].calculated_value,
      'Persisted calculation result'
    );

    logInfo('calculation.evaluate.success', {
      calculationId,
      calculatedValue: persistedCalculatedValue,
    });
    return { calculationId, calculatedValue: persistedCalculatedValue };
  } catch (err) {
    logError('calculation.evaluate.failed', {
      calculationId,
      error: err.message,
    });
    throw err;
  }
}

/**
 * Load one calculation, resolve all referenced variables, evaluate, and persist.
 *
 * @param {number} calculationId
 * @returns {Promise<{ calculationId: number, calculatedValue: string }>}
 */
async function evaluateCalculation(calculationId) {
  if (!Number.isInteger(calculationId) || calculationId <= 0) {
    throw new TypeError(`calculationId must be a positive integer, received: ${calculationId}`);
  }

  return _evaluateCalculationWithQueryable(calculationId, pool);
}

/**
 * Wraps all recalculation updates in a single database transaction.
 * Sequential execution is intentional here - concurrent writes inside one
 * transaction can cause deadlocks when rows lock each other.
 *
 * @param {number} variableId
 * @param {string} dependencyRegex
 * @returns {Promise<Array<{ calculationId: number, calculatedValue: string }>>}
 */
async function _recalculateAtomic(variableId, dependencyRegex) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const { rows: affectedCalculations } = await client.query(
      'SELECT id FROM calculations WHERE expression ~ $1',
      [dependencyRegex]
    );

    if (affectedCalculations.length === 0) {
      await client.query('COMMIT');
      return [];
    }

    logInfo('calculation.recalculate.start', {
      variableId,
      atomic: true,
      affectedCount: affectedCalculations.length,
    });

    const results = [];
    for (const row of affectedCalculations) {
      results.push(await _evaluateCalculationWithQueryable(row.id, client));
    }

    await client.query('COMMIT');
    return results;
  } catch (err) {
    await client.query('ROLLBACK');
    logError('calculation.recalculate.failed', {
      variableId,
      atomic: true,
      error: err.message,
    });
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Re-evaluate all calculations that reference the provided variable ID.
 *
 * Behavior:
 * - returns [] when no matching calculations are found
 * - when options.atomic=true, wraps updates in a single transaction
 *
 * @param {number} variableId
 * @param {{ atomic?: boolean }} [options]
 * @returns {Promise<Array<{ calculationId: number, calculatedValue: string }>>}
 */
async function recalculate(variableId, options = {}) {
  if (!Number.isInteger(variableId) || variableId <= 0) {
    throw new TypeError(`variableId must be a positive integer, received: ${variableId}`);
  }

  // Regex requires a valid JSON field terminator (comma or closing brace)
  // after the numeric id, which prevents false positives such as id:10
  // or id:1e2 matching a search for id:1.
  const dependencyRegex = `"id"[[:space:]]*:[[:space:]]*${variableId}[[:space:]]*[,}]`;

  if (options.atomic === true) {
    return _recalculateAtomic(variableId, dependencyRegex);
  }

  try {
    const { rows: affectedCalculations } = await pool.query(
      'SELECT id FROM calculations WHERE expression ~ $1',
      [dependencyRegex]
    );

    if (affectedCalculations.length === 0) {
      return [];
    }

    logInfo('calculation.recalculate.start', {
      variableId,
      atomic: false,
      affectedCount: affectedCalculations.length,
    });

    // Each calculation writes to its own row with no cross-row dependencies,
    // so concurrent evaluation is safe here. If calculations ever referenced
    // each other's output, a topological sort would be required before this step.
    return Promise.all(affectedCalculations.map((row) => evaluateCalculation(row.id)));
  } catch (err) {
    logError('calculation.recalculate.failed', {
      variableId,
      atomic: false,
      error: err.message,
    });
    throw err;
  }
}

module.exports = {
  evaluateCalculation,
  recalculate,
  extractJsonSnippets,
  buildEvaluableExpression,
  isAllowedArithmeticExpression,
  evaluateExpression,
};

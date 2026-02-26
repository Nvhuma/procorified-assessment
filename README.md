# Procurified Assessment - Senior Node.js Backend Engineer

## Overview

This repository contains solutions for:

- Problem 1: Resource lineage query (`src/lineage.js`)
- Problem 2: Expression evaluation and recalculation (`src/calculations.js`)

---

## Setup

### Prerequisites

- Node.js >= 18
- PostgreSQL running locally
- The `procurifieddb` database created before running anything:

```sql
CREATE DATABASE procurifieddb;
```

### Install dependencies

```bash
npm install

# PowerShell execution-policy fallback:
npm.cmd ci
```

### Configure database credentials

Copy the example env file and fill in your PostgreSQL password:

```bash
# macOS/Linux/Git Bash
cp .env.example .env

# PowerShell
Copy-Item .env.example .env

# Command Prompt
copy .env.example .env
```

Open `.env` and set `DB_PASSWORD` to your local Postgres password. If your Postgres has no password, leave it empty. The other defaults should work for a standard local installation without changes.

> `.env` is gitignored and will never be committed.

### Seed the database

Creates the required tables and inserts sample data:

```bash
node sql/seed.js
```

You should see `Seed complete.`

---

## Run tests

```bash
# Unit + integration (requires a running PostgreSQL instance - tests seed themselves)
node tests/index.test.js

# Unit tests only (no DB required, macOS/Linux/Git Bash)
DB_SKIP_INTEGRATION=true node tests/index.test.js

# Unit tests only (PowerShell)
$env:DB_SKIP_INTEGRATION='true'; node tests/index.test.js

# Unit tests only (Command Prompt)
set DB_SKIP_INTEGRATION=true && node tests/index.test.js
```

Expected output: all tests pass (counts can vary as tests evolve).

---

## Design decisions

### Problem 1: lineage ordering and safety

- Uses a recursive CTE with a `depth` column.
- Ancestors are sorted by `depth DESC`, which guarantees root-to-parent ordering regardless of ID assignment order.
- Uses a cycle guard (`path` array) and throws a clear error when a cycle is detected.
- Throws `Resource with id <id> not found` when the target row does not exist.

### Problem 2: expression parsing and recalculation

- Supports one or more JSON snippets in a single expression.
- Each snippet is parsed and validated to contain a positive integer `id`.
- All referenced variable values are loaded, substituted, and evaluated via `mathjs` BigNumber mode.
- Uses an arithmetic token allowlist before evaluation to block unsupported expressions.
- `recalculate(variableId)` uses a PostgreSQL regex pattern:
  - `"id"[[:space:]]*:[[:space:]]*<variableId>[[:space:]]*[,}]`
  - Tolerates whitespace variants (`"id":1`, `"id" : 1`, `"id": 1`)
  - Avoids false positives like matching `10` or `1e2` when searching for `1`
- Returns `[]` when no calculations reference the given variable.
- Supports optional `recalculate(variableId, { atomic: true })` for all-or-nothing updates.
- Variable and calculated numeric values are stored as `NUMERIC(18, 6)` in PostgreSQL.

> Production note: storing variable references as text inside the expression column works for this format, but a `calculation_variables` junction table would be a cleaner long-term design and would replace regex search with indexed joins.

### Precision and numeric types

All arithmetic is evaluated in mathjs BigNumber mode with 64-digit precision to
avoid JavaScript floating-point drift (e.g. 0.1 + 0.2 returning 0.30000000000000004).
Results are persisted in PostgreSQL as NUMERIC(18,6), and evaluateCalculation
returns that persisted value as a decimal string so returned and stored values stay aligned.
Callers must not coerce calculated values to JavaScript Number - pass them
directly to the database or format them as strings for display.

---

## Libraries

| Library | Reason |
|---------|--------|
| `pg` | PostgreSQL client with built-in connection pooling |
| `mathjs` | Expression evaluator that avoids `eval()` |
| `dotenv` | Loads credentials from `.env` into `process.env` |
| `logger` (custom) | Structured JSON logging with LOG_LEVEL control - keeps test output clean and surfaces errors consistently |

---

## CI

GitHub Actions runs:

- Unit tests on every push/PR
- Integration tests with a PostgreSQL service container

---

## Tradeoffs

- Precision choice: calculations are evaluated in BigNumber mode and persisted as `NUMERIC(18,6)` to avoid JS floating-point drift.
- Transactional behavior: default `recalculate` mode is concurrent for throughput; use `{ atomic: true }` when all-or-nothing consistency is required.
- Parser assumption: JSON snippets are matched as simple `{...}` blocks (no nested braces), which keeps the implementation small for the assessment format.

---

## Project structure

```text
.
|-- src/
|   |-- db.js               # Shared connection pool
|   |-- logger.js           # Structured JSON logging with LOG_LEVEL control
|   |-- lineage.js          # Problem 1
|   |-- calculations.js     # Problem 2
|   `-- index.js
|-- sql/
|   |-- bootstrap.js        # Shared schema definition and seed data (used by seed.js and tests)
|   `-- seed.js             # CLI entry point - runs bootstrap and exits cleanly
|-- tests/
|   `-- index.test.js       # Unit + integration tests
|-- .github/workflows/
|   `-- ci.yml              # Unit + integration CI jobs
|-- .env.example            # Template - copy to .env and fill in password
|-- .gitignore
|-- package.json
`-- README.md
```

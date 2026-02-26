/**
 * Minimal structured logging helpers.
 *
 * LOG_LEVEL values:
 * - debug: log everything
 * - info: log info + error
 * - error: log errors only (default)
 * - silent: suppress all logs
 */

const LEVEL_WEIGHT = {
  debug: 10,
  info: 20,
  error: 40,
  silent: 100,
};

function getConfiguredLevel() {
  const configured = String(process.env.LOG_LEVEL || 'error').toLowerCase();
  return LEVEL_WEIGHT[configured] !== undefined ? configured : 'error';
}

function shouldLog(level) {
  return LEVEL_WEIGHT[level] >= LEVEL_WEIGHT[getConfiguredLevel()];
}

function emit(level, event, metadata = {}) {
  if (!shouldLog(level)) {
    return;
  }

  const payload = {
    timestamp: new Date().toISOString(),
    level,
    event,
    ...metadata,
  };

  const line = JSON.stringify(payload);
  if (level === 'error') {
    console.error(line);
    return;
  }

  console.log(line);
}

function logInfo(event, metadata = {}) {
  emit('info', event, metadata);
}

function logError(event, metadata = {}) {
  emit('error', event, metadata);
}

module.exports = { logInfo, logError };

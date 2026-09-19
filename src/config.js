'use strict';

const DEFAULT_ENDPOINT = 'http://127.0.0.1:4318/v1/traces';

function bool(raw, fallback) {
  if (raw === undefined || raw === null || String(raw).trim() === '') return fallback;
  return !['0', 'false', 'no', 'off'].includes(String(raw).trim().toLowerCase());
}

function number(raw, fallback, minimum) {
  const value = Number(raw);
  return Number.isFinite(value) && value >= minimum ? value : fallback;
}

/**
 * Settings from SLOWPOKE_* environment variables, like the other packages. Nonsense values fall
 * back to the defaults: a typo in an env file must never stop an application from booting.
 */
function fromEnv(env = process.env) {
  return {
    enabled: bool(env.SLOWPOKE_ENABLED, true),
    endpoint: (env.SLOWPOKE_OTLP_ENDPOINT || '').trim() || DEFAULT_ENDPOINT,
    timeout: number(env.SLOWPOKE_TIMEOUT, 0.1, 0.001),
    service: (env.SLOWPOKE_SERVICE || '').trim() || null,
    maxQueries: number(env.SLOWPOKE_MAX_QUERIES, 500, 0),
    maxSqlLength: number(env.SLOWPOKE_MAX_SQL_LENGTH, 10000, 1),
    backtraceLimit: number(env.SLOWPOKE_BACKTRACE_LIMIT, 60, 1),
    codeRoot: (env.SLOWPOKE_CODE_ROOT || '').trim() || null,
    maxInFlight: number(env.SLOWPOKE_MAX_IN_FLIGHT, 32, 1),
  };
}

module.exports = { DEFAULT_ENDPOINT, fromEnv, bool, number };

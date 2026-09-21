'use strict';

/**
 * Tells Slowpoke which line of your Node app ran each query.
 *
 * One trace per HTTP request (Express, Fastify), per job and per command, with the route template,
 * the status and every query with its file:line, sent to the Slowpoke agent on the same machine.
 */

const path = require('node:path');

const { fromEnv } = require('./config');
const { OriginFinder } = require('./origin');
const { install: traceHttpClients } = require('./http');
const { HttpSender } = require('./sender');
const { Tracer, VERSION, current } = require('./tracer');

const state = { built: false, tracer: null, explicit: {}, defaults: {}, sender: null };

/**
 * Builds the tracer now from the SLOWPOKE_* variables, with these options on top: any setting
 * (enabled, endpoint, timeout, service, maxQueries, maxSqlLength, backtraceLimit, codeRoot,
 * httpClient, maxHttpCalls),
 * plus `sender` (an object with send(string)) for tests. Returns null when Slowpoke is disabled.
 */
function configure(overrides = {}) {
  state.explicit = { ...overrides };
  state.built = false;
  return getTracer();
}

/** The tracer the integrations use, built from the environment on first use; null when disabled. */
function getTracer() {
  if (state.built) return state.tracer;
  state.built = true;
  state.tracer = null;
  state.sender = null;
  try {
    const config = { ...fromEnv(), ...state.defaults, ...state.explicit };
    if (!config.enabled) return null;
    const sender = state.explicit.sender ||
      HttpSender.fromUrl(config.endpoint, config.timeout, config.maxInFlight);
    // Not a local or private endpoint: nothing may be sent, so nothing is recorded either.
    if (!sender) return null;
    const codeRoot = path.resolve(String(config.codeRoot || process.cwd()));
    const tracer = new Tracer({
      origin: new OriginFinder(codeRoot, config.backtraceLimit),
      submit: null,
      service: config.service || path.basename(codeRoot) || 'node',
      maxQueries: config.maxQueries,
      maxSqlLength: config.maxSqlLength,
      httpClient: config.httpClient,
      maxHttpCalls: config.maxHttpCalls,
      agentEndpoint: config.endpoint,
    });
    tracer.submit = (trace) => sender.send(tracer.encodeJson(trace));
    state.sender = sender;
    state.tracer = tracer;
    // fetch, undici, http and https: the wrappers ask the tracer on every call, so turning this
    // off later (a new configure) needs no unpatching.
    if (config.httpClient) traceHttpClients();
    return tracer;
  } catch (e) {
    return null; // a broken configuration disables Slowpoke, it never stops the app from booting
  }
}

/** Framework defaults (codeRoot, service) that apply only where the environment is silent. */
function setDefaults(defaults = {}) {
  const merged = { ...state.defaults };
  for (const [key, value] of Object.entries(defaults)) {
    if (value !== undefined && value !== null && value !== '') merged[key] = value;
  }
  state.defaults = merged;
  state.built = false;
}

function reset() {
  state.built = false;
  state.tracer = null;
  state.explicit = {};
  state.defaults = {};
  state.sender = null;
}

/** Waits up to `ms` for the traces already sent to reach the agent. Never needed in a server. */
async function flush(ms = 1000) {
  getTracer();
  return state.sender && typeof state.sender.drain === 'function' ? state.sender.drain(ms) : true;
}

/**
 * Traces work outside a request: a queue worker, a script, your own loop.
 *
 *     await slowpoke.job('send_invoices', () => { ... }, { queue: 'emails' })
 *
 * Inside a request or another job it does nothing: those queries already belong to that trace.
 */
function job(name, fn, options = {}) {
  return background('job', name, fn, options.queue);
}

/** The same for a command run by cron. */
function command(name, fn) {
  return background('command', name, fn, null);
}

function background(kind, name, fn, queue) {
  const tracer = getTracer();
  const trace = tracer === null ? null
    : (kind === 'job' ? tracer.startJob(name, queue) : tracer.startCommand(name));
  if (trace === null) return fn();

  let result;
  try {
    result = tracer.run(trace, fn);
  } catch (error) {
    tracer.finishJob(trace, true);
    throw error;
  }
  if (result && typeof result.then === 'function') {
    return result.then(
      (value) => { tracer.finishJob(trace, false); return value; },
      (error) => { tracer.finishJob(trace, true); throw error; },
    );
  }
  tracer.finishJob(trace, false);
  return result;
}

module.exports = {
  configure, getTracer, setDefaults, reset, flush, job, command, current, VERSION,
  get express() { return require('./express'); },
  get fastify() { return require('./fastify'); },
  get pg() { return require('./pg'); },
  get mysql2() { return require('./mysql2'); },
  get bullmq() { return require('./bullmq'); },
};

'use strict';

const { AsyncLocalStorage } = require('node:async_hooks');

const slowpoke = require('./index');
const { current } = require('./tracer');

// A pool hands the statement to a connection in a callback of its own, so the application's frames
// are gone by the time the driver runs it: the origin has to be read at the pool, where the
// application called. The inner layer is then silenced, or the same statement would be counted
// twice - once by the pool and once by the connection underneath it.
const silenced = new AsyncLocalStorage();

/** Seconds, monotonic: a clock change must not turn a query into a negative duration. */
function now() {
  return Number(process.hrtime.bigint()) / 1e9;
}

/**
 * Times one statement and records it with the line of application code that asked for it. The
 * origin is read here, at the call, because by the time a query resolves that stack is gone.
 *
 * Returns null when there is nothing to record (Slowpoke off, or outside a request or a job), so
 * the driver call goes through untouched: no timer, no stack, no allocation.
 */
function begin(sql, system, skipAbove) {
  const tracer = slowpoke.getTracer();
  const asked = current();
  if (tracer === null || asked === null || !sql || silenced.getStore()) return null;
  const origin = tracer.origins(sql, skipAbove);
  const started = now();
  let recorded = false;
  // The trace travels with the record: by the time a pool runs this statement and calls back,
  // the context is the one its queue was in, not the request that asked.
  const record = () => {
    if (recorded) return;
    recorded = true;
    tracer.recordQuery(sql, now() - started, system, origin, asked);
  };
  record.trace = asked;
  return record;
}

/**
 * The driver, as the application sees it. require() alone looks next to this package, which is the
 * wrong place when it is installed as a link or hoisted somewhere else: a workspace, a monorepo,
 * npm link, a Docker image built from a local path. The application's own directory is where the
 * driver it uses actually lives, and instrument(require('pg')) always settles it.
 */
function driver(name, given) {
  if (given) return given;
  try {
    return require(name);
  } catch (e) {
    try {
      return require(require.resolve(name, { paths: [process.cwd(), ...(require.main ? [require.main.path] : [])] }));
    } catch (again) {
      return null; // not installed here: nothing to instrument, and nothing to complain about
    }
  }
}

/** Runs the driver call with the layers underneath silenced: one statement, one record. */
function outermost(fn) {
  return silenced.run(true, fn);
}

/** The SQL a driver was handed, whatever shape the call used. */
function statement(first) {
  if (typeof first === 'string') return first;
  if (first && typeof first.text === 'string') return first.text; // pg config or Submittable
  if (first && typeof first.sql === 'string') return first.sql; // mysql2 options
  return null;
}

/** Records when the promise settles, either way: a failed query is still time somebody waited. */
function onSettled(result, record) {
  if (result && typeof result.then === 'function') {
    return result.then(
      (value) => { record(); return value; },
      (error) => { record(); throw error; },
    );
  }
  return null;
}

/** Records when an emitter-shaped query (pg's Query, mysql2's Command) is done. */
function onEnded(emitter, record) {
  if (!emitter || typeof emitter.on !== 'function') return false;
  emitter.on('end', record);
  emitter.on('error', record);
  return true;
}

/**
 * Wraps a driver callback so the query is recorded exactly once, before the caller is resumed.
 *
 * The callback is the door back to the application, and what comes through it is the request's
 * own code: it runs in the request that asked for the statement, and never silenced. A pool calls
 * back from wherever its queue happened to be drained - another request, or none at all - and
 * whatever the application does there, another query above all, would otherwise be filed under a
 * stranger, dropped as an inner layer, or lost for having no request at all.
 */
function wrapCallback(callback, record) {
  return function slowpokeCallback(...args) {
    record();
    const resume = () => silenced.exit(() => callback.apply(this, args));
    const tracer = slowpoke.getTracer();
    return tracer !== null && record.trace ? tracer.run(record.trace, resume) : resume();
  };
}

module.exports = { begin, outermost, driver, statement, onSettled, onEnded, wrapCallback, now };

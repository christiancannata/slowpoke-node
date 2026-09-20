'use strict';

const crypto = require('node:crypto');
const { AsyncLocalStorage } = require('node:async_hooks');

const VERSION = '0.1.3';

const SERVER = 2;
const CLIENT = 3;
const CONSUMER = 5;

// The trace of the request, task or command this code is running inside. AsyncLocalStorage follows
// awaits, callbacks and timers, so a query five layers deep still knows which request it belongs to.
const storage = new AsyncLocalStorage();

function current() {
  const trace = storage.getStore();
  return trace && trace.end === null ? trace : null;
}

/**
 * Collects one trace per request, job or command and encodes it for the agent: a SERVER (or
 * CONSUMER) span and one CLIENT span per query, with the SQL as the driver received it
 * (placeholders, never parameter values) and the application line that ran it.
 *
 * Every public method swallows its own errors: observability must never break the application.
 */
class Tracer {
  constructor({ origin, submit, service = 'node', version = VERSION, maxQueries = 500,
    maxSqlLength = 10000, clock = () => Date.now() / 1000, ids = randomId } = {}) {
    this.origin = origin;
    this.submit = submit;
    this.service = service;
    this.version = version;
    this.maxQueries = Math.max(0, maxQueries);
    this.maxSqlLength = Math.max(1, maxSqlLength);
    this.clock = clock;
    this.ids = ids;
  }

  // ------------------------------------------------------------------ requests

  startRequest(method) {
    try {
      const name = String(method || 'GET').toUpperCase();
      const trace = this.newTrace(SERVER, name);
      trace.method = name;
      return trace;
    } catch (e) {
      return null;
    }
  }

  finishRequest(trace, route, path, status, host) {
    if (!trace || trace.end !== null) return;
    try {
      trace.end = this.clock();
      trace.attributes.push(kv('http.request.method', trace.method));
      if (route) {
        const template = '/' + String(route).replace(/^\/+/, '');
        trace.name = `${trace.method} ${template}`;
        trace.attributes.push(kv('http.route', template));
      } else {
        // No route matched: the path stands in for it, without the query string.
        trace.attributes.push(kv('url.path', '/' + String(path || '').split('?')[0].replace(/^\/+/, '')));
      }
      trace.attributes.push(kv('http.response.status_code', Math.trunc(status)));
      // The host this request was answered for. With a web server in front on another machine,
      // it is the only thing that says its access log and this trace are the same requests, so
      // that nobody counts them twice.
      if (host) trace.attributes.push(kv('server.address', String(host).toLowerCase()));
      trace.error = status >= 500;
    } catch (e) {
      trace.end = trace.end || this.clock();
    }
    this.done(trace);
  }

  // ------------------------------------------------------------------ jobs and commands

  /** Work a queue handed to a worker. */
  startJob(name, queue) {
    return this.startBackground(name, 'job', queue);
  }

  /** A command run by cron: nobody waits for it, which is why nobody notices when it doubles. */
  startCommand(name) {
    return this.startBackground(name, 'command', null);
  }

  startBackground(name, kind, queue) {
    if (current() !== null) return null; // work run inside a request or another job belongs to it
    try {
      const trace = this.newTrace(CONSUMER, String(name));
      // The agent files it under Jobs by this attribute, instead of among the endpoints.
      trace.attributes.push(kv('slowpoke.kind', kind));
      if (queue) trace.attributes.push(kv('messaging.destination.name', String(queue)));
      return trace;
    } catch (e) {
      return null;
    }
  }

  finishJob(trace, failed = false) {
    if (!trace || trace.end !== null) return;
    trace.end = this.clock();
    trace.error = Boolean(failed);
    this.done(trace);
  }

  // ------------------------------------------------------------------ queries

  /**
   * The line of application code to blame for this statement. Reading a stack is by far the most
   * expensive thing this package does (tens of microseconds), so it is read once per statement per
   * trace: the thirty-one repeats of an N+1 cost one stack, not thirty-one, and they all point at
   * the same line anyway - which is exactly the line the panel shows.
   */
  originFor(sql, skipAbove) {
    const trace = current();
    if (trace === null || !this.origin) return null;
    const known = trace.origins.get(sql);
    if (known !== undefined) return known;
    const found = this.origin.find(skipAbove || this.originFor);
    if (trace.origins.size < 200) trace.origins.set(sql, found); // bounded, like everything here
    return found;
  }

  /**
   * Called right after a statement ran. The trace is the one of whoever asked for it, captured
   * when the application called: a pool finishes the statement in a callback of its own, in
   * whatever context it was queued from, and looking the trace up here would file the query
   * under somebody else's request or drop it.
   */
  recordQuery(sql, seconds, system, origin, asked) {
    const trace = asked || current();
    if (!trace) return; // outside a request, a job or a command: a pool warming up, a migration
    try {
      if (trace.queries.length >= this.maxQueries) {
        trace.dropped += 1;
        return;
      }
      const text = String(sql);
      const end = this.clock();
      trace.queries.push({
        sql: text.length > this.maxSqlLength ? text.slice(0, this.maxSqlLength) : text,
        system: String(system || 'other_sql'),
        start: Math.max(trace.start, end - Math.max(0, seconds)),
        end,
        origin: origin === undefined ? this.originFor(text, this.recordQuery) : origin,
      });
    } catch (e) {
      // never let observability break the query that was just run
    }
  }

  /** The origin, read now: once a query resolves that stack is gone. Never throws. */
  origins(sql, skipAbove) {
    try {
      return this.originFor(sql, skipAbove);
    } catch (e) {
      return null;
    }
  }

  // ------------------------------------------------------------------ plumbing

  run(trace, fn) {
    return trace === null ? fn() : storage.run(trace, fn);
  }

  newTrace(kind, name) {
    return {
      kind, name, start: this.clock(), end: null, error: false,
      traceId: this.ids(16), spanId: this.ids(8),
      attributes: [], queries: [], dropped: 0, method: null, origins: new Map(),
    };
  }

  done(trace) {
    try {
      if (typeof this.submit === 'function') this.submit(trace);
    } catch (e) {
      // the agent is optional: a missing or broken one costs a trace, nothing else
    }
  }

  encode(trace) {
    const root = {
      traceId: trace.traceId,
      spanId: trace.spanId,
      name: trace.name,
      kind: trace.kind,
      startTimeUnixNano: nanos(trace.start),
      endTimeUnixNano: nanos(trace.end),
      attributes: trace.attributes.slice(),
    };
    if (trace.dropped > 0) root.attributes.push(kv('slowpoke.dropped_queries', trace.dropped));
    if (trace.error) root.status = { code: 2 };
    const spans = [root];
    for (const query of trace.queries) {
      const attributes = [kv('db.system.name', query.system), kv('db.query.text', query.sql)];
      if (query.origin) {
        attributes.push(kv('code.file.path', query.origin[0]));
        if (query.origin[1] !== null && query.origin[1] !== undefined) {
          attributes.push(kv('code.line.number', Math.trunc(query.origin[1])));
        }
      }
      spans.push({
        traceId: trace.traceId,
        spanId: this.ids(8),
        parentSpanId: trace.spanId,
        name: firstWord(query.sql),
        kind: CLIENT,
        startTimeUnixNano: nanos(query.start),
        endTimeUnixNano: nanos(query.end),
        attributes,
      });
    }
    return {
      resourceSpans: [{
        resource: {
          attributes: [
            kv('service.name', this.service),
            kv('telemetry.sdk.name', 'slowpoke-node'),
            kv('telemetry.sdk.language', 'nodejs'),
            kv('telemetry.sdk.version', this.version),
          ],
        },
        scopeSpans: [{ scope: { name: 'slowpoke/node', version: this.version }, spans }],
      }],
    };
  }

  encodeJson(trace) {
    return JSON.stringify(this.encode(trace));
  }
}

function firstWord(sql) {
  const match = /^[\s(]*([A-Za-z_]+)/.exec(String(sql));
  return match ? match[1].toUpperCase() : 'QUERY';
}

function nanos(seconds) {
  // Microseconds, like the other packages, and rounded the same way: floor(x + 0.5), so the same
  // measure produces the same trace in every language.
  return `${Math.floor(seconds * 1e6 + 0.5)}000`;
}

function kv(key, value) {
  return Number.isInteger(value)
    ? { key, value: { intValue: String(value) } }
    : { key, value: { stringValue: String(value) } };
}

function randomId(bytes) {
  return crypto.randomBytes(bytes).toString('hex');
}

module.exports = { Tracer, VERSION, SERVER, CLIENT, CONSUMER, current, storage, nanos, kv };

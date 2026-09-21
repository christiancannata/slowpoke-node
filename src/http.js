'use strict';

const { AsyncLocalStorage } = require('node:async_hooks');
const diagnostics = require('node:diagnostics_channel');

const { current } = require('./tracer');

/**
 * Outbound HTTP calls, one span each, inside the trace that is open.
 *
 * The line to blame is only on the stack while the application makes the call: diagnostics
 * channels are published later (undici creates its request a few awaits down, http only once a
 * socket is assigned), so the calls are caught where they start and the channels say how they end.
 *
 * - fetch (undici, built into Node): globalThis.fetch is wrapped for the start, the line and the
 *   failure to connect (undici publishes nothing then); the undici:request:* channels, matched to
 *   that fetch through an AsyncLocalStorage, give the status and the end of the body. A redirect is
 *   the same call. undici used directly from npm has no wrapper: its channels alone make the span.
 * - http and https: request() and get() are wrapped (get() calls the module's own request(), not
 *   the export, so nothing is counted twice) and ESM imports are synced; the status comes from the
 *   http.client.response.finish channel and the end from the request's 'close'. The package adds no
 *   'response' or 'error' listener: Node keeps dumping unread responses and throwing unhandled errors
 *   exactly as it did.
 *
 * The package's own sender posts after the trace has ended, so it is never inside one, and the
 * tracer skips the agent's address anyway.
 */

const MARK = Symbol.for('slowpoke.http');
const fetchCall = new AsyncLocalStorage();
const calls = new WeakMap(); // undici or http request -> call
let installed = false;

function install() {
  if (installed) return;
  installed = true;
  try {
    wrapModule(require('node:http'), 'http:');
    wrapModule(require('node:https'), 'https:');
    require('node:module').syncBuiltinESMExports();
  } catch (e) {
    // a module that cannot be patched is a module that is not traced, nothing else
  }
  try {
    if (typeof globalThis.fetch === 'function' && !globalThis.fetch[MARK]) globalThis.fetch = wrapFetch(globalThis.fetch);
  } catch (e) {
    // same
  }
  subscribe('undici:request:create', onUndiciCreate);
  subscribe('undici:request:headers', ({ request, response }) => {
    const entry = calls.get(request);
    if (entry) entry.tracer.httpResponse(entry.call, response && response.statusCode);
  });
  subscribe('undici:request:trailers', ({ request }) => {
    const entry = calls.get(request);
    if (entry) entry.tracer.httpEnd(entry.call);
  });
  subscribe('undici:request:error', ({ request }) => {
    const entry = calls.get(request);
    if (entry) entry.tracer.httpFail(entry.call);
  });
  subscribe('http.client.response.finish', ({ request, response }) => {
    const entry = calls.get(request);
    if (entry) entry.tracer.httpResponse(entry.call, response && response.statusCode);
  });
}

/** The tracer, when a trace is open here and outbound calls are to be recorded. */
function active() {
  if (current() === null) return null;
  const tracer = require('./index').getTracer();
  return tracer !== null && tracer.httpClient ? tracer : null;
}

function subscribe(name, handler) {
  const safe = (message) => {
    try {
      handler(message || {});
    } catch (e) {
      // never let observability break the call the application is making
    }
  };
  try {
    if (typeof diagnostics.subscribe === 'function') diagnostics.subscribe(name, safe);
    else diagnostics.channel(name).subscribe(safe);
  } catch (e) {
    // an older Node without this channel: those calls simply end with their trace
  }
}

// ------------------------------------------------------------------ fetch and undici

function wrapFetch(original) {
  const fetch = function fetch(input, init) {
    const tracer = active();
    const call = tracer === null ? null : startFetch(tracer, input, init, fetch);
    if (call === null) return original.apply(this, arguments);
    let promise;
    try {
      promise = fetchCall.run(call, () => original.apply(this, arguments));
    } catch (error) {
      tracer.httpFail(call);
      throw error;
    }
    return promise.then(
      (response) => { tracer.httpResponse(call, response && response.status); return response; },
      (error) => { tracer.httpFail(call); throw error; },
    );
  };
  fetch[MARK] = true;
  return fetch;
}

function startFetch(tracer, input, init, skipAbove) {
  try {
    const request = input !== null && typeof input === 'object' && !(input instanceof URL) ? input : null;
    const method = (init && init.method) || (request && request.method) || 'GET';
    return tracer.startHttpCall(method, request ? request.url : String(input), skipAbove);
  } catch (e) {
    return null;
  }
}

function onUndiciCreate({ request }) {
  if (!request) return;
  const call = fetchCall.getStore();
  if (call !== undefined) {
    // One of our fetches: the tracer and the call are already known, a redirect adds a request.
    calls.set(request, { tracer: require('./index').getTracer(), call });
    return;
  }
  const tracer = active();
  if (tracer === null) return;
  // undici used directly: its origin is scheme, host and port; the path is never read.
  const direct = tracer.startHttpCall(request.method, String(request.origin), onUndiciCreate);
  if (direct !== null) calls.set(request, { tracer, call: direct });
}

// ------------------------------------------------------------------ http and https

function wrapModule(module, protocol) {
  for (const name of ['request', 'get']) {
    const original = module[name];
    if (typeof original !== 'function' || original[MARK]) continue;
    const wrapped = function (input, options) {
      const tracer = active();
      const call = tracer === null ? null : startHttp(tracer, input, options, protocol, name, wrapped);
      if (call === null) return original.apply(this, arguments);
      let request;
      try {
        request = original.apply(this, arguments);
      } catch (error) {
        tracer.httpFail(call);
        throw error;
      }
      watch(tracer, call, request);
      return request;
    };
    Object.defineProperty(wrapped, 'name', { value: original.name });
    wrapped[MARK] = true;
    module[name] = wrapped;
  }
}

function startHttp(tracer, input, options, protocol, name, skipAbove) {
  try {
    let url = null;
    let opts = null;
    if (typeof input === 'string' || input instanceof URL) {
      url = new URL(input);
      if (options !== null && typeof options === 'object') opts = options;
    } else if (input !== null && typeof input === 'object') {
      opts = input;
    }
    const o = opts || {};
    const where = {
      protocol: o.protocol || (url ? url.protocol : protocol),
      hostname: o.hostname || (o.host ? String(o.host).replace(/:\d+$/, '') : null) || (url ? url.hostname : 'localhost'),
      port: o.port || (url ? url.port : null),
    };
    const method = name === 'get' ? 'GET' : (o.method || 'GET');
    return tracer.startHttpCall(method, where, skipAbove);
  } catch (e) {
    return null;
  }
}

function watch(tracer, call, request) {
  try {
    calls.set(request, { tracer, call });
    request.once('close', () => {
      // 'close' comes once the response is over, or once the request failed without one.
      const response = request.res;
      if (response) {
        if (call.status === null) tracer.httpResponse(call, response.statusCode);
        tracer.httpEnd(call);
      } else {
        tracer.httpFail(call);
      }
    });
  } catch (e) {
    // never let observability break the call the application is making
  }
}

module.exports = { install };

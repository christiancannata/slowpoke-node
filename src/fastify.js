'use strict';

const slowpoke = require('./index');
const { storage } = require('./tracer');

/**
 * One trace per request:
 *
 *     await app.register(require('@slowpokedev/node').fastify)
 *
 * enterWith, not run: Fastify's hooks are a chain of their own, and the trace has to follow the
 * handler that runs after this hook returns.
 */
function plugin(fastify, options, done) {
  fastify.addHook('onRequest', (request, reply, next) => {
    try {
      const tracer = slowpoke.getTracer();
      if (tracer !== null) {
        const trace = tracer.startRequest(request.method);
        if (trace !== null) {
          request.slowpokeTrace = trace;
          storage.enterWith(trace);
        }
      }
    } catch (e) {
      // never let observability break the request
    }
    next();
  });

  fastify.addHook('onResponse', (request, reply, next) => {
    try {
      const tracer = slowpoke.getTracer();
      const trace = request.slowpokeTrace;
      if (tracer !== null && trace) {
        tracer.finishRequest(trace, routeOf(request), request.url || '/', reply.statusCode || 0, hostOf(request));
      }
    } catch (e) {
      // as above
    }
    next();
  });

  done();
}

/** "/orders/:id", however this Fastify version spells it. */
function routeOf(request) {
  const options = request.routeOptions;
  return (options && options.url) || request.routerPath || (request.context && request.context.config &&
    request.context.config.url) || null;
}

// The host the request was addressed to, without the port: "shop.example.com". A proxy in front
// on another machine logs the same requests, and this is what says they are the same.
function hostOf(req) {
  const headers = (req && req.headers) || {};
  const raw = headers[':authority'] || headers.host || '';
  // "shop.example.com:8443" and "[::1]:3000" both lose the port; the first of a comma-separated
  // list is the one the request was addressed to.
  return String(raw).split(',')[0].trim().toLowerCase().replace(/:\d+$/, '');
}

// Fastify only accepts a plugin that says it is one.
plugin[Symbol.for('skip-override')] = true;
plugin[Symbol.for('fastify.display-name')] = 'slowpoke';

module.exports = plugin;
module.exports.plugin = plugin;
module.exports.routeOf = routeOf;

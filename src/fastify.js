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
        tracer.finishRequest(trace, routeOf(request), request.url || '/', reply.statusCode || 0);
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

// Fastify only accepts a plugin that says it is one.
plugin[Symbol.for('skip-override')] = true;
plugin[Symbol.for('fastify.display-name')] = 'slowpoke';

module.exports = plugin;
module.exports.plugin = plugin;
module.exports.routeOf = routeOf;

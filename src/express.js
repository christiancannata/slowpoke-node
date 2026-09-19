'use strict';

const slowpoke = require('./index');

/**
 * One trace per request:
 *
 *     app.use(require('@slowpoke/node').express())   // first, so the timing covers the others
 *
 * The route template (/orders/:id) is read when the response is done, because that is when Express
 * knows which route matched.
 */
function middleware() {
  return function slowpokeExpress(req, res, next) {
    const tracer = slowpoke.getTracer();
    if (tracer === null) return next();
    const trace = tracer.startRequest(req.method);
    if (trace === null) return next();

    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      try {
        tracer.finishRequest(trace, routeOf(req), req.originalUrl || req.url || '/', res.statusCode || 0);
      } catch (e) {
        // never let observability break the response
      }
    };
    res.on('finish', finish);
    res.on('close', finish); // the client hung up: the work still happened

    return tracer.run(trace, next);
  };
}

/** "/orders/:id" with the mount point, or null when nothing matched (a 404). */
function routeOf(req) {
  const route = req.route && req.route.path;
  if (!route) return null;
  const base = req.baseUrl || '';
  const full = `${base}${route === '/' && base ? '' : route}`;
  return full || '/';
}

module.exports = middleware;
module.exports.middleware = middleware;
module.exports.routeOf = routeOf;

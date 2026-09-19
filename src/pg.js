'use strict';

const { begin, driver, outermost, statement, onSettled, onEnded, wrapCallback } = require('./sql');

const patched = new WeakSet();

/**
 * Times every statement node-postgres runs, whoever asked for it: an ORM on top (TypeORM, Sequelize,
 * Knex, Drizzle) goes through the same client.
 *
 *     require('@slowpoke/node').pg.instrument()          // the pg in node_modules
 *     require('@slowpoke/node').pg.instrument(myPg)      // or the module you already required
 *
 * Idempotent: a statement is never recorded twice.
 */
function instrument(pg) {
  try {
    const module = driver('pg', pg);
    if (module === null) return false;
    for (const owner of [module.Pool, module.Client, module.native && module.native.Client]) {
      if (owner && owner.prototype) patch(owner.prototype);
    }
    return true;
  } catch (e) {
    return false; // pg is not installed, or is something else entirely: nothing to do
  }
}

function patch(prototype) {
  if (patched.has(prototype) || typeof prototype.query !== 'function') return;
  const original = prototype.query;

  prototype.query = function slowpokeQuery(config, values, callback) {
    const record = begin(statement(config), 'postgresql', slowpokeQuery);
    if (record === null) return original.apply(this, arguments);

    // query(text, cb) and query(text, values, cb): the driver answers through the callback.
    const last = arguments.length >= 3 ? callback : values;
    if (typeof last === 'function') {
      const args = Array.prototype.slice.call(arguments);
      args[arguments.length - 1] = wrapCallback(last, record);
      return outermost(() => original.apply(this, args));
    }

    const result = outermost(() => original.apply(this, arguments));
    // A Submittable (pg.Query, a cursor) reports through its own events; anything else is a promise.
    return onSettled(result, record) || (onEnded(result, record), result);
  };
  patched.add(prototype);
}

module.exports = { instrument };

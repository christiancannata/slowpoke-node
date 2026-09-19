'use strict';

const { begin, driver, outermost, statement, onSettled, onEnded, wrapCallback } = require('./sql');

const patched = new WeakSet();

/**
 * Times every statement mysql2 runs, query() and execute(), callbacks and promises alike: the
 * promise wrapper and the pools go through the same connection underneath, and so do the ORMs.
 *
 *     require('@slowpoke/node').mysql2.instrument()
 *
 * Idempotent: a statement is never recorded twice.
 */
function instrument(mysql2) {
  try {
    const module = driver('mysql2', mysql2);
    if (module === null) return false;
    // The pool first: that is where an application calls, and the promise wrappers go straight
    // through it. The connection underneath is patched too, for code that holds one directly.
    for (const owner of [module.Pool, module.Connection]) {
      if (owner && owner.prototype) patch(owner.prototype);
    }
    return true;
  } catch (e) {
    return false;
  }
}

function patch(prototype) {
  if (!prototype || patched.has(prototype)) return;
  for (const name of ['query', 'execute']) {
    if (typeof prototype[name] !== 'function') continue;
    const original = prototype[name];
    prototype[name] = function slowpokeStatement(sql, values, callback) {
      const record = begin(statement(sql), 'mysql', slowpokeStatement);
      if (record === null) return original.apply(this, arguments);

      for (let i = arguments.length - 1; i >= 1; i--) {
        if (typeof arguments[i] === 'function') {
          const args = Array.prototype.slice.call(arguments);
          args[i] = wrapCallback(arguments[i], record);
          return outermost(() => original.apply(this, args));
        }
      }
      const result = outermost(() => original.apply(this, arguments));
      return onSettled(result, record) || (onEnded(result, record), result);
    };
  }
  patched.add(prototype);
}

module.exports = { instrument };

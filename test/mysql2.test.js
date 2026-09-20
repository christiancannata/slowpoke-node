'use strict';

const assert = require('node:assert');
const { test } = require('node:test');

const slowpoke = require('../src/index');
const { attr, install, lineOf } = require('./helpers');

/** A connection with the shapes mysql2 answers in: callback, and the promise wrapper's. */
function fakeModule() {
  class Connection {
    query(sql, values, callback) {
      return this.run(arguments);
    }

    execute(sql, values, callback) {
      return this.run(arguments);
    }

    run(args) {
      for (let i = args.length - 1; i >= 1; i--) {
        if (typeof args[i] === 'function') {
          setImmediate(() => args[i](null, [], []));
          return { started: true };
        }
      }
      return Promise.resolve([[], []]);
    }
  }
  return { Connection };
}

async function inRequest(t, body) {
  const { tracer, sender } = install(t);
  const trace = tracer.startRequest('GET');
  await tracer.run(trace, async () => {
    await body();
    tracer.finishRequest(trace, '/orders', '/orders', 200);
  });
  return sender.onlyTrace();
}

test('query and execute are both recorded, with their origin', async (t) => {
  const module = fakeModule();
  slowpoke.mysql2.instrument(module);
  const connection = new module.Connection();

  const [, queries] = await inRequest(t, async () => {
    await connection.execute('SELECT * FROM orders WHERE id = ?', [7]); // @query execute
    await new Promise((resolve) => connection.query('SELECT NOW()', () => resolve()));
  });

  assert.deepStrictEqual(queries.map((q) => attr(q, 'db.query.text')), ['SELECT * FROM orders WHERE id = ?', 'SELECT NOW()']);
  assert.strictEqual(attr(queries[0], 'db.system.name'), 'mysql');
  assert.strictEqual(attr(queries[0], 'code.file.path'), 'test/mysql2.test.js');
  assert.strictEqual(attr(queries[0], 'code.line.number'), String(lineOf(__filename, 'execute')));
});

test('the options shape ({ sql }) is recorded as well, and only once', async (t) => {
  const module = fakeModule();
  slowpoke.mysql2.instrument(module);
  slowpoke.mysql2.instrument(module);
  const connection = new module.Connection();

  const [, queries] = await inRequest(t, async () => {
    await connection.query({ sql: 'SELECT 1 FROM dual', timeout: 100 });
  });

  assert.deepStrictEqual(queries.map((q) => attr(q, 'db.query.text')), ['SELECT 1 FROM dual']);
});

test('the real mysql2 module has the shape this package patches', () => {
  const mysql2 = require('mysql2');
  const before = mysql2.Connection.prototype.query;
  try {
    assert.strictEqual(slowpoke.mysql2.instrument(), true);
    assert.notStrictEqual(mysql2.Connection.prototype.query, before, 'Connection.prototype.query was not wrapped');
  } finally {
    mysql2.Connection.prototype.query = before;
  }
});

/** The same trap as pg: with a pool the statement runs from a callback of the pool's own. */
test('a query through a pool keeps the line that asked for it, and is recorded once', async (t) => {
  const module = fakeModule();
  module.Pool = class Pool {
    constructor() { this.connection = new module.Connection(); }
    query(sql, values, callback) {
      return new Promise((resolve, reject) => {
        setImmediate(() => this.connection.query(sql, values).then(resolve, reject));
      });
    }
    execute(sql, values) { return this.query(sql, values); }
  };
  slowpoke.mysql2.instrument(module);
  const pool = new module.Pool();

  const [, queries] = await inRequest(t, async () => {
    await pool.query('SELECT name FROM products WHERE id = ?', [7]); // @query pool
  });

  assert.strictEqual(queries.length, 1, 'the pool and the connection must not both record it');
  assert.strictEqual(attr(queries[0], 'code.file.path'), 'test/mysql2.test.js');
  assert.strictEqual(attr(queries[0], 'code.line.number'), String(lineOf(__filename, 'pool')));
});

/**
 * A real pool does not answer on the spot: it queues the statement and runs it when a connection
 * frees up, from whatever context its queue is being drained in - another request, or none. This
 * fake does the same, draining from a timer started outside any request.
 */
function fakePool(queue) {
  class Connection {
    query(sql, values, callback) {
      const args = arguments;
      for (let i = args.length - 1; i >= 1; i--) {
        if (typeof args[i] === 'function') {
          queue.push(() => args[i](null, [], []));
          return { started: true };
        }
      }
      return new Promise((resolve) => queue.push(() => resolve([[], []])));
    }
  }
  class Pool extends Connection {}
  return { Pool, Connection };
}

test('a pool that answers from its own queue still files the query under the request that asked', async (t) => {
  const queue = [];
  // Drained outside every request, as a pool drains when a connection frees up.
  const drain = setInterval(() => { const next = queue.shift(); if (next) next(); }, 1);
  t.after(() => clearInterval(drain));

  const module = fakePool(queue);
  slowpoke.mysql2.instrument(module);
  const { tracer, sender } = install(t);
  const pool = new module.Pool();

  const trace = tracer.startRequest('GET');
  await tracer.run(trace, async () => {
    await new Promise((resolve, reject) => pool.query('SELECT 1', [], (e) => (e ? reject(e) : resolve())));
    await new Promise((resolve, reject) => pool.query('SELECT 2', [], (e) => (e ? reject(e) : resolve())));
    tracer.finishRequest(trace, '/orders', '/orders', 200);
  });

  const [, queries] = sender.onlyTrace();
  assert.deepStrictEqual(queries.map((q) => attr(q, 'db.query.text')), ['SELECT 1', 'SELECT 2'],
    'a pooled query must not be lost');
});

test('a statement issued from inside another statement\'s callback is recorded too', async (t) => {
  const queue = [];
  const drain = setInterval(() => { const next = queue.shift(); if (next) next(); }, 1);
  t.after(() => clearInterval(drain));

  const module = fakePool(queue);
  slowpoke.mysql2.instrument(module);
  const { tracer, sender } = install(t);
  const pool = new module.Pool();

  const trace = tracer.startRequest('GET');
  await tracer.run(trace, async () => {
    await new Promise((resolve, reject) => {
      pool.query('SELECT outer', [], (first) => {
        if (first) return reject(first);
        // Callback style: the second statement is asked for from inside the first one's answer.
        pool.query('SELECT inner', [], (second) => (second ? reject(second) : resolve()));
      });
    });
    tracer.finishRequest(trace, '/orders', '/orders', 200);
  });

  const [, queries] = sender.onlyTrace();
  assert.deepStrictEqual(queries.map((q) => attr(q, 'db.query.text')), ['SELECT outer', 'SELECT inner']);
});

'use strict';

const assert = require('node:assert');
const { EventEmitter } = require('node:events');
const { test } = require('node:test');

const slowpoke = require('../src/index');
const { attr, install, lineOf } = require('./helpers');

/** A client with the shapes node-postgres answers in: promise, callback, and a Submittable. */
function fakeModule() {
  class Client {
    query(config, values, callback) {
      const last = typeof callback === 'function' ? callback : (typeof values === 'function' ? values : null);
      if (last) {
        setImmediate(() => last(null, { rows: [] }));
        return { submitted: true };
      }
      if (config && typeof config.submit === 'function') {
        setImmediate(() => config.emit('end'));
        return config;
      }
      return Promise.resolve({ rows: [] });
    }
  }
  return { Client };
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

test('a query through the promise interface is recorded with its origin', async (t) => {
  const module = fakeModule();
  slowpoke.pg.instrument(module);
  const client = new module.Client();

  const [, queries] = await inRequest(t, async () => {
    await client.query('SELECT * FROM orders WHERE id = $1', [7]); // @query promise
  });

  assert.strictEqual(queries.length, 1);
  assert.strictEqual(attr(queries[0], 'db.system.name'), 'postgresql');
  assert.strictEqual(attr(queries[0], 'db.query.text'), 'SELECT * FROM orders WHERE id = $1');
  assert.strictEqual(attr(queries[0], 'code.file.path'), 'test/pg.test.js');
  assert.strictEqual(attr(queries[0], 'code.line.number'), String(lineOf(__filename, 'promise')));
});

test('the callback and config shapes are recorded too, and exactly once', async (t) => {
  const module = fakeModule();
  slowpoke.pg.instrument(module);
  slowpoke.pg.instrument(module); // twice on purpose: a statement must never be counted twice
  const client = new module.Client();

  const [, queries] = await inRequest(t, async () => {
    await new Promise((resolve) => client.query('SELECT 1', (err, res) => resolve(res)));
    await new Promise((resolve) => client.query('SELECT 2', [], () => resolve()));
    await client.query({ text: 'SELECT 3 FROM orders' });
  });

  assert.deepStrictEqual(queries.map((q) => attr(q, 'db.query.text')), ['SELECT 1', 'SELECT 2', 'SELECT 3 FROM orders']);
});

test('a Submittable (a cursor, a prepared query) is recorded when it ends', async (t) => {
  const module = fakeModule();
  slowpoke.pg.instrument(module);
  const client = new module.Client();

  const [, queries] = await inRequest(t, async () => {
    const query = Object.assign(new EventEmitter(), { text: 'SELECT * FROM big_table', submit() {} });
    client.query(query);
    await new Promise((resolve) => query.on('end', resolve));
  });

  assert.deepStrictEqual(queries.map((q) => attr(q, 'db.query.text')), ['SELECT * FROM big_table']);
});

test('outside a request the driver is not even timed', async (t) => {
  const module = fakeModule();
  slowpoke.pg.instrument(module);
  const { sender } = install(t);
  await new module.Client().query('SELECT 1');
  assert.deepStrictEqual(sender.payloads, []);
});

test('the real pg module has the shape this package patches', () => {
  const pg = require('pg');
  const before = pg.Client.prototype.query;
  try {
    assert.strictEqual(slowpoke.pg.instrument(), true);
    assert.notStrictEqual(pg.Client.prototype.query, before, 'pg.Client.prototype.query was not wrapped');
  } finally {
    pg.Client.prototype.query = before;
  }
});

/**
 * A pool hands the work to a connection in a callback, so by the time the driver runs the
 * statement the application's own frames are long gone from the stack. Found in the lab: every
 * query of a real Express app arrived without its file and line, which is the whole point of this
 * package. The origin has to be read where the application called, at the pool.
 */
test('a query through a pool keeps the line that asked for it', async (t) => {
  const module = fakeModule();
  module.Pool = class Pool {
    constructor(clients) { this.client = new module.Client(); }
    query(config, values, callback) {
      // What node-postgres does: get a connection, then run the statement from that callback.
      return new Promise((resolve, reject) => {
        setImmediate(() => this.client.query(config, values).then(resolve, reject));
      });
    }
  };
  slowpoke.pg.instrument(module);
  const pool = new module.Pool();

  const [, queries] = await inRequest(t, async () => {
    await pool.query('SELECT name FROM customers WHERE id = $1', [7]); // @query pool
  });

  assert.strictEqual(queries.length, 1, 'the statement must be recorded once, not twice');
  assert.strictEqual(attr(queries[0], 'db.query.text'), 'SELECT name FROM customers WHERE id = $1');
  assert.strictEqual(attr(queries[0], 'code.file.path'), 'test/pg.test.js');
  assert.strictEqual(attr(queries[0], 'code.line.number'), String(lineOf(__filename, 'pool')));
});

test('a driver that is not installed is not an error, it is just nothing to do', () => {
  const { begin, driver } = require('../src/sql');
  assert.strictEqual(driver('a-driver-nobody-has'), null);
  assert.strictEqual(typeof begin, 'function');
  // The package can be installed as a link, where require() from here finds nothing: the
  // application's own directory is looked at too, which is how the lab found this.
  assert.ok(driver('pg') !== null, 'pg must be found from wherever this package sits');
});

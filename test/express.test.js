'use strict';

const assert = require('node:assert');
const { test } = require('node:test');

const express = require('express');

const slowpoke = require('../src/index');
const { attr, install, lineOf } = require('./helpers');

/** Runs one request against an app the way a browser would, and returns the status. */
async function request(app, path, method = 'GET') {
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const { port } = server.address();
  const response = await fetch(`http://127.0.0.1:${port}${path}`, { method });
  await response.text();
  // The trace is sent on 'finish', which the server has already emitted by now.
  await new Promise((resolve) => server.close(resolve));
  return response.status;
}

function app(tracer) {
  const application = express();
  application.use(slowpoke.express());
  application.get('/orders/:id', (req, res) => {
    tracer.recordQuery('SELECT * FROM orders WHERE id = $1', 0.004, 'postgresql'); // @query show
    res.json({ id: req.params.id });
  });
  const api = express.Router();
  api.get('/customers', (req, res) => res.json([]));
  application.use('/api/v1', api);
  application.get('/broken', () => { throw new Error('boom'); });
  return application;
}

test('a request is one trace with the route template, not the url', async (t) => {
  const { tracer, sender } = install(t);
  assert.strictEqual(await request(app(tracer), '/orders/7'), 200);

  const [root, queries] = sender.onlyTrace();
  assert.strictEqual(root.name, 'GET /orders/:id');
  assert.strictEqual(attr(root, 'http.route'), '/orders/:id');
  assert.strictEqual(attr(root, 'http.response.status_code'), '200');
  assert.strictEqual(queries.length, 1);
  assert.strictEqual(attr(queries[0], 'code.file.path'), 'test/express.test.js');
  assert.strictEqual(attr(queries[0], 'code.line.number'), String(lineOf(__filename, 'show')));
});

test('a router keeps the path it is mounted on', async (t) => {
  const { tracer, sender } = install(t);
  await request(app(tracer), '/api/v1/customers');
  assert.strictEqual(attr(sender.onlyTrace()[0], 'http.route'), '/api/v1/customers');
});

test('nothing matched: the path stands in for the route', async (t) => {
  const { tracer, sender } = install(t);
  assert.strictEqual(await request(app(tracer), '/.env?probe=1'), 404);
  const [root] = sender.onlyTrace();
  assert.strictEqual(attr(root, 'url.path'), '/.env');
  assert.strictEqual(attr(root, 'http.response.status_code'), '404');
});

test('a handler that throws is a failed request, without its message', async (t) => {
  const { tracer, sender } = install(t);
  assert.strictEqual(await request(app(tracer), '/broken'), 500);
  const [root] = sender.onlyTrace();
  assert.deepStrictEqual(root.status, { code: 2 });
  assert.ok(!sender.payloads[0].includes('boom'), 'the exception message must never leave the machine');
});

test('with Slowpoke disabled the middleware is a pass-through', async (t) => {
  const { sender } = install(t, { enabled: false });
  const application = express();
  application.use(slowpoke.express());
  application.get('/', (req, res) => res.send('ok'));
  assert.strictEqual(await request(application, '/'), 200);
  assert.deepStrictEqual(sender.payloads, []);
});

test('two requests at the same time never mix their queries', async (t) => {
  const { tracer, sender } = install(t);
  const application = express();
  application.use(slowpoke.express());
  application.get('/slow/:id', async (req, res) => {
    const id = req.params.id;
    tracer.recordQuery(`SELECT ${id} FROM before`, 0.001, 'postgresql');
    await new Promise((resolve) => setTimeout(resolve, 20 * Number(id)));
    tracer.recordQuery(`SELECT ${id} FROM after`, 0.001, 'postgresql');
    res.json({ id });
  });

  const server = application.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const { port } = server.address();
  await Promise.all([1, 2, 3].map(async (id) => {
    const response = await fetch(`http://127.0.0.1:${port}/slow/${id}`);
    await response.text();
  }));
  await new Promise((resolve) => server.close(resolve));

  assert.strictEqual(sender.payloads.length, 3);
  for (const payload of sender.decoded()) {
    const spans = payload.resourceSpans[0].scopeSpans[0].spans;
    const statements = spans.filter((s) => s.kind === 3).map((s) => attr(s, 'db.query.text'));
    assert.strictEqual(statements.length, 2, `one request got ${statements.length} queries`);
    const id = statements[0].split(' ')[1];
    assert.deepStrictEqual(statements, [`SELECT ${id} FROM before`, `SELECT ${id} FROM after`],
      'a request must only carry its own queries');
  }
});

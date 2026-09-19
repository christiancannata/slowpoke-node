'use strict';

const assert = require('node:assert');
const { test } = require('node:test');

const Fastify = require('fastify');

const slowpoke = require('../src/index');
const { attr, install, lineOf } = require('./helpers');

async function app(tracer) {
  const application = Fastify();
  await application.register(slowpoke.fastify);
  application.get('/orders/:id', async (request) => {
    tracer.recordQuery('SELECT * FROM orders WHERE id = $1', 0.004, 'postgresql'); // @query show
    return { id: request.params.id };
  });
  application.get('/broken', async () => { throw new Error('boom'); });
  return application;
}

async function request(application, path) {
  const response = await application.inject({ method: 'GET', url: path });
  await application.close(); // onResponse has run by the time inject resolves
  return response.statusCode;
}

test('a request is one trace with the route template and the query origin', async (t) => {
  const { tracer, sender } = install(t);
  assert.strictEqual(await request(await app(tracer), '/orders/7'), 200);

  const [root, queries] = sender.onlyTrace();
  assert.strictEqual(root.name, 'GET /orders/:id');
  assert.strictEqual(attr(root, 'http.route'), '/orders/:id');
  assert.strictEqual(queries.length, 1, 'the query ran inside the request, so it belongs to it');
  assert.strictEqual(attr(queries[0], 'code.file.path'), 'test/fastify.test.js');
  assert.strictEqual(attr(queries[0], 'code.line.number'), String(lineOf(__filename, 'show')));
});

test('nothing matched: the path stands in for the route', async (t) => {
  const { tracer, sender } = install(t);
  assert.strictEqual(await request(await app(tracer), '/.env?probe=1'), 404);
  assert.strictEqual(attr(sender.onlyTrace()[0], 'url.path'), '/.env');
});

test('a handler that throws is a failed request, without its message', async (t) => {
  const { tracer, sender } = install(t);
  assert.strictEqual(await request(await app(tracer), '/broken'), 500);
  assert.deepStrictEqual(sender.onlyTrace()[0].status, { code: 2 });
  assert.ok(!sender.payloads[0].includes('boom'));
});

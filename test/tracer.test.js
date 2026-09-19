'use strict';

const assert = require('node:assert');
const { test } = require('node:test');

const { attr, make } = require('./helpers');
const { nanos } = require('../src/tracer');

test('a request is one trace with its route, status and queries', () => {
  const { tracer, sender, clock } = make();
  const trace = tracer.startRequest('get');
  tracer.run(trace, () => {
    clock.now += 0.04;
    tracer.recordQuery('SELECT * FROM orders WHERE id = $1', 0.02, 'postgresql', ['src/orders.js', 18]);
    clock.now += 0.01;
    tracer.finishRequest(trace, '/orders/:id', '/orders/7?from=mail', 200);
  });

  const [root, queries] = sender.onlyTrace();
  assert.strictEqual(root.kind, 2);
  assert.strictEqual(root.name, 'GET /orders/:id');
  assert.strictEqual(attr(root, 'http.route'), '/orders/:id');
  assert.strictEqual(attr(root, 'http.request.method'), 'GET');
  assert.strictEqual(attr(root, 'http.response.status_code'), '200');
  assert.strictEqual(root.status, undefined);
  assert.strictEqual(queries.length, 1);
  assert.strictEqual(queries[0].name, 'SELECT');
  assert.strictEqual(attr(queries[0], 'db.query.text'), 'SELECT * FROM orders WHERE id = $1');
  assert.strictEqual(attr(queries[0], 'code.file.path'), 'src/orders.js');
  assert.strictEqual(attr(queries[0], 'code.line.number'), '18');
  assert.strictEqual(queries[0].parentSpanId, root.spanId);
});

test('no route matched: the path stands in for it, without the query string', () => {
  const { tracer, sender } = make();
  const trace = tracer.startRequest('GET');
  tracer.run(trace, () => tracer.finishRequest(trace, null, '/.env?probe=1', 404));

  const [root] = sender.onlyTrace();
  assert.strictEqual(attr(root, 'url.path'), '/.env');
  assert.strictEqual(attr(root, 'http.route'), null);
  assert.strictEqual(root.status, undefined, 'a 404 is the caller being wrong, not the app failing');
});

test('a server error is an error', () => {
  const { tracer, sender } = make();
  const trace = tracer.startRequest('POST');
  tracer.run(trace, () => tracer.finishRequest(trace, '/orders', '/orders', 500));
  assert.deepStrictEqual(sender.onlyTrace()[0].status, { code: 2 });
});

test('queries outside a request or a job are not recorded', () => {
  const { tracer, sender } = make();
  tracer.recordQuery('SELECT 1', 0.001, 'postgresql', null);
  assert.deepStrictEqual(sender.payloads, []);
});

test('past the limit queries are counted, not described', () => {
  const { tracer, sender } = make({ maxQueries: 2 });
  const trace = tracer.startRequest('GET');
  tracer.run(trace, () => {
    for (let i = 0; i < 5; i++) tracer.recordQuery(`SELECT ${i}`, 0.001, 'postgresql', null);
    tracer.finishRequest(trace, '/', '/', 200);
  });
  const [root, queries] = sender.onlyTrace();
  assert.strictEqual(queries.length, 2);
  assert.strictEqual(attr(root, 'slowpoke.dropped_queries'), '3');
});

test('a trace says what it is: a job, a command, or an endpoint', () => {
  const { tracer, sender } = make();
  const job = tracer.startJob('send_invoices', 'emails');
  tracer.run(job, () => tracer.finishJob(job, false));
  const command = tracer.startCommand('close_orders');
  tracer.run(command, () => tracer.finishJob(command, true));
  const request = tracer.startRequest('GET');
  tracer.run(request, () => tracer.finishRequest(request, '/', '/', 200));

  const kinds = sender.decoded().map((p) => {
    const root = p.resourceSpans[0].scopeSpans[0].spans[0];
    return [root.kind, attr(root, 'slowpoke.kind'), attr(root, 'messaging.destination.name'), root.status];
  });
  assert.deepStrictEqual(kinds, [
    [5, 'job', 'emails', undefined],
    [5, 'command', null, { code: 2 }],
    [2, null, null, undefined],
  ]);
});

test('work started inside a request belongs to that request', () => {
  const { tracer } = make();
  const request = tracer.startRequest('GET');
  tracer.run(request, () => {
    assert.strictEqual(tracer.startJob('inside', null), null);
    assert.strictEqual(tracer.startCommand('inside'), null);
  });
});

test('microseconds are rounded the same way in every language', () => {
  // floor(x + 0.5): JavaScript rounds .5 up for positives, but only this is the same rule the PHP
  // and Python packages use, and the same measure must produce the same trace everywhere.
  assert.strictEqual(nanos(1760000000.0000005), '1760000000000001000');
  assert.strictEqual(nanos(1760000000.0000015), '1760000000000002000');
});

test('the origin of a repeated statement is read once, not once per repeat', () => {
  // Reading a stack is the most expensive thing this package does; an N+1 repeats the same
  // statement thirty times and every repeat points at the same line.
  const { tracer, sender } = make();
  let stacks = 0;
  tracer.origin = { find: () => { stacks += 1; return ['src/models/order.js', 88]; } };
  const trace = tracer.startRequest('GET');
  tracer.run(trace, () => {
    for (let i = 0; i < 30; i++) tracer.recordQuery('SELECT name FROM customers WHERE id = $1', 0.001, 'postgresql');
    tracer.recordQuery('SELECT * FROM orders', 0.001, 'postgresql');
    tracer.finishRequest(trace, '/orders', '/orders', 200);
  });

  assert.strictEqual(stacks, 2, 'one stack per distinct statement, not per query');
  const [, queries] = sender.onlyTrace();
  assert.strictEqual(queries.length, 31);
  assert.ok(queries.every((q) => attr(q, 'code.file.path') === 'src/models/order.js'));
});

test('the per-request map of origins is bounded', () => {
  const { tracer } = make();
  let stacks = 0;
  tracer.origin = { find: () => { stacks += 1; return ['src/app.js', 1]; } };
  const trace = tracer.startRequest('GET');
  tracer.run(trace, () => {
    for (let i = 0; i < 500; i++) tracer.originFor(`SELECT ${i}`, null);
  });
  assert.ok(trace.origins.size <= 200, `grew to ${trace.origins.size}`);
  assert.strictEqual(stacks, 500, 'past the bound it still answers, it just stops remembering');
});

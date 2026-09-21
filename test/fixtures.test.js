'use strict';

const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');

const { make } = require('./helpers');

// spec/node_otlp_fixtures.json holds payloads exactly as this package sends them, with what the
// agent must read from each. The Go receiver test replays them: change both together.
// Regenerate with UPDATE_FIXTURES=1 ./bin/test 22 test/fixtures.test.js
const FILE = path.join(__dirname, '..', '..', '..', 'spec', 'node_otlp_fixtures.json');

function scenarios() {
  const out = [];

  {
    const { tracer, sender, clock } = make();
    const trace = tracer.startRequest('GET');
    tracer.run(trace, () => {
      clock.now += 0.045;
      tracer.recordQuery('SELECT id, customer_id FROM orders WHERE status = $1 ORDER BY created_at DESC LIMIT 25',
        0.0412, 'postgresql', ['src/routes/orders.js', 18]);
      for (let i = 0; i < 6; i++) {
        clock.now += 0.002;
        tracer.recordQuery('SELECT name FROM customers WHERE id = $1', 0.0009, 'postgresql',
          ['src/models/order.js', 88]);
      }
      clock.now += 0.01;
      // Written as a browser sends it: the host is normalised, so a web server logging
      // "shop.example.com" on another machine is recognised as the same requests.
      tracer.finishRequest(trace, '/orders', '/orders', 200, 'Shop.Example.com:8443');
    });
    out.push({
      name: 'Express + pg: an N+1 in a loop',
      payload: JSON.parse(sender.payloads[0]),
      expect: {
        route: 'GET /orders', status: 200, requests: 1, source: 'otlp:shop', site: 'shop.example.com',
        queries: [
          { statement: 'SELECT id, customer_id FROM orders WHERE status = $1 ORDER BY created_at DESC LIMIT 25',
            n: 1, origin: 'src/routes/orders.js:18', n_plus_one: false },
          { statement: 'SELECT name FROM customers WHERE id = $1', n: 6, origin: 'src/models/order.js:88',
            n_plus_one: true },
        ],
      },
    });
  }

  {
    const { tracer, sender, clock } = make();
    const trace = tracer.startRequest('PUT');
    tracer.run(trace, () => {
      clock.now += 0.02;
      tracer.recordQuery('UPDATE orders SET status = ?, updated_at = ? WHERE id = ?', 0.0035, 'mysql',
        ['src/routes/api/orders.js', 40]);
      clock.now += 0.001;
      tracer.finishRequest(trace, '/api/orders/:id', '/api/orders/981', 500);
    });
    out.push({
      name: 'Fastify + mysql2: route parameter, server error',
      payload: JSON.parse(sender.payloads[0]),
      expect: {
        route: 'PUT /api/orders/{id}', status: 500, requests: 1, source: 'otlp:shop',
        queries: [{ statement: 'UPDATE orders SET status = ?, updated_at = ? WHERE id = ?', n: 1,
          origin: 'src/routes/api/orders.js:40', n_plus_one: false }],
      },
    });
  }

  {
    const { tracer, sender, clock } = make();
    const trace = tracer.startRequest('GET');
    tracer.run(trace, () => {
      clock.now += 0.001;
      tracer.finishRequest(trace, null, '/.env?probe=1', 404);
    });
    out.push({
      name: 'no matching route: the path stands in for the route',
      payload: JSON.parse(sender.payloads[0]),
      expect: { route: 'GET /.env', status: 404, requests: 1, source: 'otlp:shop', queries: [] },
    });
  }

  {
    const { tracer, sender, clock } = make();
    const job = tracer.startJob('send-invoice', 'emails');
    tracer.run(job, () => {
      clock.now += 0.3;
      tracer.recordQuery('SELECT * FROM invoices WHERE sent_at IS NULL', 0.25, 'postgresql',
        ['src/jobs/invoices.js', 31]);
      clock.now += 0.01;
      tracer.recordQuery('UPDATE invoices SET sent_at = now() WHERE id = $1', 0.001, 'postgresql', null);
      clock.now += 0.1;
      tracer.finishJob(job, false);
    });
    out.push({
      name: 'BullMQ job: queries without an HTTP request',
      payload: JSON.parse(sender.payloads[0]),
      expect: {
        route: 'job send-invoice', status: 0, requests: 1, source: '',
        job: { kind: 'job', name: 'send-invoice', runs: 1, failed: 0 },
        queries: [
          { statement: 'SELECT * FROM invoices WHERE sent_at IS NULL', n: 1, origin: 'src/jobs/invoices.js:31',
            n_plus_one: false },
          { statement: 'UPDATE invoices SET sent_at = now() WHERE id = $1', n: 1, origin: '', n_plus_one: false },
        ],
      },
    });
  }

  {
    // Cron: nobody is waiting for it, so nobody notices when it doubles.
    const { tracer, sender, clock } = make();
    const command = tracer.startCommand('close-orders');
    tracer.run(command, () => {
      clock.now += 1.2;
      tracer.recordQuery('UPDATE orders SET closed_at = $1 WHERE closed_at IS NULL AND due_at < $2', 1.18,
        'postgresql', ['scripts/close-orders.js', 52]);
      clock.now += 0.05;
      tracer.finishJob(command, true);
    });
    out.push({
      name: 'command run by cron, and it failed',
      payload: JSON.parse(sender.payloads[0]),
      expect: {
        route: 'command close-orders', status: 0, requests: 1, source: '',
        job: { kind: 'command', name: 'close-orders', runs: 1, failed: 1 },
        queries: [{ statement: 'UPDATE orders SET closed_at = $1 WHERE closed_at IS NULL AND due_at < $2', n: 1,
          origin: 'scripts/close-orders.js:52', n_plus_one: false }],
      },
    });
  }

  {
    const { tracer, sender, clock } = make();
    let at = null;
    tracer.origin = { find: () => at }; // the line is fixed here, as the queries' origins are
    const trace = tracer.startRequest('POST');
    tracer.run(trace, () => {
      clock.now += 0.005;
      tracer.recordQuery('SELECT id, total FROM carts WHERE id = $1', 0.002, 'postgresql', ['src/routes/checkout.js', 27]);
      clock.now += 0.001;
      at = ['src/services/stripe.js', 88];
      const stripe = tracer.startHttpCall('post', 'https://api.stripe.com/v1/payment_intents?expand=customer');
      clock.now += 0.3;
      tracer.httpResponse(stripe, 200);
      clock.now += 0.12;
      tracer.httpEnd(stripe);
      clock.now += 0.002;
      at = null; // a call made from library code only
      const partner = tracer.startHttpCall('GET', 'http://Partner.Example.com:8080/stock?sku=A1');
      clock.now += 1.5;
      tracer.httpFail(partner);
      clock.now += 0.003;
      tracer.finishRequest(trace, '/checkout', '/checkout', 200);
    });
    out.push({
      name: 'request with outbound calls: one to Stripe, one failed to a partner',
      payload: JSON.parse(sender.payloads[0]),
      expect: {
        route: 'POST /checkout', status: 200, requests: 1, source: 'otlp:shop',
        queries: [
          { statement: 'SELECT id, total FROM carts WHERE id = $1', n: 1, origin: 'src/routes/checkout.js:27', n_plus_one: false },
        ],
        outbound: [
          { host: 'api.stripe.com', n: 1, errors: 0, origin: 'src/services/stripe.js:88' },
          { host: 'partner.example.com:8080', n: 1, errors: 1, origin: '' },
        ],
      },
    });
  }

  return out;
}

test('payloads match the shared fixtures', () => {
  const cases = scenarios();
  if (process.env.UPDATE_FIXTURES) {
    fs.writeFileSync(FILE, `${JSON.stringify(cases, null, 4)}\n`);
  }
  if (!fs.existsSync(FILE)) {
    return; // spec/ is only in the Slowpoke repository
  }
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(FILE, 'utf8')), cases);
});

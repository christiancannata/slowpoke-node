'use strict';

const assert = require('node:assert');
const http = require('node:http');
const net = require('node:net');
const { test, before, after } = require('node:test');

const slowpoke = require('../src/index');
const { ROOT, attr, install, lineOf, make } = require('./helpers');

let server;
let base;

before(async () => {
  server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      if (req.url.startsWith('/redirect')) {
        res.writeHead(302, { location: '/ok' });
        res.end();
        return;
      }
      res.writeHead(req.url.startsWith('/broken') ? 503 : 200, { 'content-type': 'application/json' });
      res.end('{"ok":true}');
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => new Promise((resolve) => server.close(resolve)));

function closedPort() {
  return new Promise((resolve) => {
    const s = net.createServer().listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

function calls(sender) {
  const [root, client] = sender.onlyTrace();
  return [root, client.filter((s) => attr(s, 'http.request.method') !== null)];
}

function get(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => { res.resume(); res.on('end', () => resolve(res.statusCode)); }).on('error', reject);
  });
}

test('a fetch inside a job is one client span with the host only, counted once', async (t) => {
  const { sender } = install(t);

  await slowpoke.job('sync', async () => {
    const res = await fetch(`${base}/v1/charges?customer=cus_secret`, { headers: { authorization: 'Bearer sk_secret' } }); // @query fetch
    await res.json();
  });

  const [root, found] = calls(sender);
  assert.strictEqual(found.length, 1);
  const [call] = found;
  assert.strictEqual(call.kind, 3);
  assert.strictEqual(call.parentSpanId, root.spanId);
  assert.strictEqual(call.traceId, root.traceId);
  assert.strictEqual(call.name, 'GET 127.0.0.1');
  assert.strictEqual(attr(call, 'http.request.method'), 'GET');
  assert.strictEqual(attr(call, 'server.address'), '127.0.0.1');
  assert.strictEqual(attr(call, 'server.port'), String(server.address().port));
  assert.strictEqual(attr(call, 'http.response.status_code'), '200');
  assert.strictEqual(attr(call, 'code.file.path'), 'test/http-client.test.js');
  assert.strictEqual(attr(call, 'code.line.number'), String(lineOf(__filename, 'fetch')));
  assert.strictEqual(call.status, undefined);
  assert.ok(BigInt(root.startTimeUnixNano) <= BigInt(call.startTimeUnixNano));
  assert.ok(BigInt(call.startTimeUnixNano) <= BigInt(call.endTimeUnixNano));
  assert.ok(BigInt(call.endTimeUnixNano) <= BigInt(root.endTimeUnixNano));
  for (const secret of ['v1/charges', 'cus_secret', 'sk_secret', 'Bearer', 'http://']) {
    assert.ok(!sender.payloads[0].includes(secret), secret);
  }
});

test('a redirect followed by fetch is still one call', async (t) => {
  const { sender } = install(t);
  await slowpoke.job('sync', async () => { await (await fetch(`${base}/redirect`)).text(); });
  const [, found] = calls(sender);
  assert.strictEqual(found.length, 1);
  assert.strictEqual(attr(found[0], 'http.response.status_code'), '200');
});

test('an http.get inside a job is one client span with the line that made it', async (t) => {
  const { sender } = install(t);

  await slowpoke.job('sync', async () => {
    await new Promise((resolve) => {
      http.get(`${base}/partner/feed?token=zzz`, (res) => { res.resume(); res.on('end', resolve); }); // @query http
    });
  });

  const [, found] = calls(sender);
  assert.strictEqual(found.length, 1);
  assert.strictEqual(found[0].name, 'GET 127.0.0.1');
  assert.strictEqual(attr(found[0], 'http.response.status_code'), '200');
  assert.strictEqual(attr(found[0], 'code.line.number'), String(lineOf(__filename, 'http')));
  assert.ok(!sender.payloads[0].includes('zzz'));
});

test('an http request nobody listens to is still drained by Node, not held by the package', async (t) => {
  const { sender } = install(t);
  await slowpoke.job('sync', async () => {
    const req = http.request(`${base}/fire-and-forget`, { method: 'POST' });
    req.end();
    assert.strictEqual(req.listenerCount('response'), 0);
    assert.strictEqual(req.listenerCount('error'), 0);
    await new Promise((resolve) => req.on('close', resolve));
  });
  const [, found] = calls(sender);
  assert.strictEqual(found.length, 1);
  assert.strictEqual(found[0].name, 'POST 127.0.0.1');
  assert.strictEqual(attr(found[0], 'http.response.status_code'), '200');
});

test('a 5xx is an error', async (t) => {
  const { sender } = install(t);
  await slowpoke.job('sync', async () => {
    await (await fetch(`${base}/broken`)).text();
    await get(`${base}/broken`);
  });
  const [, found] = calls(sender);
  assert.strictEqual(found.length, 2);
  for (const call of found) {
    assert.deepStrictEqual(call.status, { code: 2 });
    assert.strictEqual(attr(call, 'http.response.status_code'), '503');
  }
});

test('a connection that fails is an error span, and the application still gets its error', async (t) => {
  const { sender } = install(t);
  const port = await closedPort();
  await slowpoke.job('sync', async () => {
    await assert.rejects(fetch(`http://127.0.0.1:${port}/x?token=zzz`));
    await assert.rejects(get(`http://127.0.0.1:${port}/x?token=zzz`));
  });
  const [, found] = calls(sender);
  assert.strictEqual(found.length, 2);
  for (const call of found) {
    assert.deepStrictEqual(call.status, { code: 2 });
    assert.strictEqual(attr(call, 'http.response.status_code'), null);
  }
  assert.ok(!sender.payloads[0].includes('zzz'));
});

test('calls outside a trace are ignored', async (t) => {
  const { sender } = install(t);
  await (await fetch(`${base}/ok`)).text();
  await get(`${base}/ok`);
  assert.deepStrictEqual(sender.payloads, []);
});

test('the cap counts the rest', async (t) => {
  const { sender } = install(t, { maxHttpCalls: 2 });
  await slowpoke.job('sync', async () => {
    for (let i = 0; i < 5; i++) await get(`${base}/ok`);
  });
  const [root, found] = calls(sender);
  assert.strictEqual(found.length, 2);
  assert.strictEqual(attr(root, 'slowpoke.dropped_http_calls'), '3');
});

test('calls to the agent are never traced', async (t) => {
  const { sender } = install(t, { endpoint: `${base}/v1/traces` });
  await slowpoke.job('sync', async () => {
    await (await fetch(`${base}/v1/traces`, { method: 'POST', body: '{}' })).text();
  });
  const [, found] = calls(sender);
  assert.deepStrictEqual(found, []);
});

test('the real sender posting to the agent is not traced', async (t) => {
  const posted = [];
  const agent = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => { posted.push(body); res.end(); });
  });
  await new Promise((resolve) => agent.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => agent.close(resolve)));
  slowpoke.configure({ endpoint: `http://127.0.0.1:${agent.address().port}/v1/traces`, codeRoot: ROOT });
  t.after(() => slowpoke.reset());

  await slowpoke.job('sync', async () => { await get(`${base}/ok`); });
  await slowpoke.flush(2000);

  assert.strictEqual(posted.length, 1);
  const spans = JSON.parse(posted[0]).resourceSpans[0].scopeSpans[0].spans;
  assert.strictEqual(spans.filter((s) => s.kind === 3).length, 1, 'the call to /ok, not the delivery');
});

test('the switch turns it off', async (t) => {
  const previous = process.env.SLOWPOKE_HTTP_CLIENT;
  process.env.SLOWPOKE_HTTP_CLIENT = 'false';
  t.after(() => {
    if (previous === undefined) delete process.env.SLOWPOKE_HTTP_CLIENT;
    else process.env.SLOWPOKE_HTTP_CLIENT = previous;
  });
  const { sender } = install(t);
  await slowpoke.job('sync', async () => {
    await (await fetch(`${base}/ok`)).text();
    await get(`${base}/ok`);
  });
  const [, found] = calls(sender);
  assert.deepStrictEqual(found, []);
});

test('ESM imports of node:http see the same function', async (t) => {
  install(t);
  const esm = await import('node:http');
  assert.strictEqual(esm.get, http.get);
  assert.strictEqual(esm.request, http.request);
});

test('default ports are not sent, an unfinished call ends with its trace as an error', () => {
  const { tracer, sender } = make();
  const trace = tracer.startJob('x');
  tracer.run(trace, () => {
    const call = tracer.startHttpCall('post', 'https://API.Stripe.com:443/v1/charges?x=1');
    tracer.httpResponse(call, 200);
    tracer.httpEnd(call);
    tracer.startHttpCall('GET', 'http://slow.example:8080/a');
  });
  tracer.finishJob(trace);
  const [root, found] = calls(sender);
  assert.strictEqual(found[0].name, 'POST api.stripe.com');
  assert.strictEqual(attr(found[0], 'server.port'), null);
  assert.strictEqual(attr(found[1], 'server.port'), '8080');
  assert.strictEqual(found[1].endTimeUnixNano, root.endTimeUnixNano);
  assert.deepStrictEqual(found[1].status, { code: 2 });
});

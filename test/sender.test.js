'use strict';

const assert = require('node:assert');
const http = require('node:http');
const { test } = require('node:test');

const { HttpSender, isPrivate } = require('../src/sender');

test('only a local or private address in plain http is ever sent to', () => {
  for (const url of ['http://127.0.0.1:4318/v1/traces', 'http://localhost:4318/v1/traces',
    'http://10.1.2.3:4318/v1/traces', 'http://192.168.1.9:4318/v1/traces', 'http://172.20.0.5:4318/v1/traces',
    'http://agent:4318/v1/traces', 'http://agent.internal:4318/v1/traces', 'http://[::1]:4318/v1/traces']) {
    assert.ok(HttpSender.fromUrl(url, 0.1) !== null, url);
  }
  for (const url of ['https://agent.example.com/v1/traces', 'http://8.8.8.8:4318/v1/traces',
    'http://example.com:4318/v1/traces', 'http://172.32.0.1:4318/v1/traces', 'not a url', '']) {
    assert.strictEqual(HttpSender.fromUrl(url, 0.1), null, url);
  }
  assert.strictEqual(isPrivate('169.254.1.1'), true);
});

test('the agent gets the payload', async () => {
  const received = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => { received.push([req.method, req.url, body]); res.writeHead(200); res.end(); });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();

  const sender = HttpSender.fromUrl(`http://127.0.0.1:${port}/v1/traces`, 1);
  sender.send('{"resourceSpans":[]}');
  assert.strictEqual(await sender.drain(2000), true);
  assert.deepStrictEqual(received, [['POST', '/v1/traces', '{"resourceSpans":[]}']]);
  server.close();
});

test('an agent that is not there costs a trace, never an error', async () => {
  // Nothing listens on this port: the send must fail quietly and let the caller carry on.
  const sender = HttpSender.fromUrl('http://127.0.0.1:1/v1/traces', 0.05);
  assert.strictEqual(sender.send('{}'), true);
  assert.strictEqual(await sender.drain(2000), true);
});

test('an agent that never answers is dropped at the time budget', async () => {
  const server = http.createServer(() => { /* accepts and says nothing, ever */ });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();

  const sender = HttpSender.fromUrl(`http://127.0.0.1:${port}/v1/traces`, 0.05);
  const started = Date.now();
  sender.send('{}');
  await sender.drain(2000);
  assert.ok(Date.now() - started < 1500, 'the send hung past its budget');
  server.close();
});

test('past the number of requests in flight traces are dropped, never queued', async () => {
  const server = http.createServer(() => {});
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();

  const sender = HttpSender.fromUrl(`http://127.0.0.1:${port}/v1/traces`, 0.5, 2);
  assert.strictEqual(sender.send('{}'), true);
  assert.strictEqual(sender.send('{}'), true);
  assert.strictEqual(sender.send('{}'), false, 'the third one had to be dropped');
  server.close();
  await sender.drain(2000);
});

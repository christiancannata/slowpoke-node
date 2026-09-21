'use strict';

const assert = require('node:assert');
const { test } = require('node:test');

const slowpoke = require('../src/index');
const { attr, install } = require('./helpers');

test('a job is a trace of its own, with its queue and its queries', async (t) => {
  const { tracer, sender } = install(t);

  const result = await slowpoke.job('send_invoices', async () => {
    tracer.recordQuery('SELECT * FROM invoices WHERE sent_at IS NULL', 0.25, 'postgresql');
    return 7;
  }, { queue: 'emails' });

  assert.strictEqual(result, 7);
  const [root, queries] = sender.onlyTrace();
  assert.strictEqual(root.kind, 5);
  assert.strictEqual(root.name, 'send_invoices');
  assert.strictEqual(attr(root, 'slowpoke.kind'), 'job');
  assert.strictEqual(attr(root, 'messaging.destination.name'), 'emails');
  assert.strictEqual(queries.length, 1);
});

test('a job that throws is a failed run, and the error still reaches the caller', async (t) => {
  const { sender } = install(t);

  await assert.rejects(slowpoke.job('send_invoices', async () => { throw new Error('no mail server'); }));

  const [root] = sender.onlyTrace();
  assert.deepStrictEqual(root.status, { code: 2 });
  assert.ok(!sender.payloads[0].includes('mail server'));
});

test('a synchronous command is traced too', async (t) => {
  const { sender } = install(t);
  const value = slowpoke.command('close_orders', () => 3);
  assert.strictEqual(value, 3);
  const [root] = sender.onlyTrace();
  assert.strictEqual(attr(root, 'slowpoke.kind'), 'command');
  assert.strictEqual(root.name, 'close_orders');
});

test('a BullMQ processor is one trace per job, named after it', async (t) => {
  const { tracer, sender } = install(t);
  const processor = slowpoke.bullmq.processor(async (job) => {
    tracer.recordQuery('UPDATE invoices SET sent_at = now()', 0.01, 'postgresql');
    return job.data;
  });

  await processor({ name: 'send-invoice', id: '12', queueName: 'emails', data: 'ok' });

  const [root, queries] = sender.onlyTrace();
  assert.strictEqual(root.name, 'send-invoice');
  assert.strictEqual(attr(root, 'slowpoke.kind'), 'job');
  assert.strictEqual(attr(root, 'messaging.destination.name'), 'emails');
  assert.strictEqual(queries.length, 1);
});

test('a job without a real name is named after its queue, never after its id', async (t) => {
  // Bull 3 names a job added without a name "__default__"; an empty name would fall back to the id,
  // one Jobs page row per run ("repeat:3f1c...:1760000000000"). The queue is the work's name then.
  const { sender } = install(t);
  const processor = slowpoke.bullmq.processor(async () => 1);

  await processor({ name: '__default__', id: '981', queue: { name: 'thumbnails' } });
  await processor({ name: '', id: 'repeat:3f1c:1760000000000', queueName: 'reports' });
  await processor({ id: '7' });

  const names = sender.payloads.map((p) => JSON.parse(p).resourceSpans[0].scopeSpans[0].spans[0].name);
  assert.deepStrictEqual(names, ['thumbnails', 'reports', 'job']);
});

test('with Slowpoke disabled the helpers just run the work', async (t) => {
  const { sender } = install(t, { enabled: false });
  assert.strictEqual(await slowpoke.job('x', async () => 1), 1);
  assert.strictEqual(slowpoke.command('y', () => 2), 2);
  assert.deepStrictEqual(sender.payloads, []);
});

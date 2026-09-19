'use strict';

const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');

const { OriginFinder } = require('../src/origin');
const { ROOT, lineOf } = require('./helpers');

/** A module that stands in for a driver in node_modules: its frames must be skipped. */
function fakeDriver() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'slowpoke-'));
  const modules = path.join(dir, 'node_modules', 'fake-driver');
  fs.mkdirSync(modules, { recursive: true });
  const file = path.join(modules, 'index.js');
  fs.writeFileSync(file, 'module.exports = { run: (finder) => finder.find() };\n');
  return { dir, driver: require(file) };
}

test('the origin is the first line of the application, never the driver', () => {
  const { dir, driver } = fakeDriver();
  const finder = new OriginFinder(ROOT, 60);
  const origin = driver.run(finder); // @query fake
  assert.deepStrictEqual(origin, ['test/origin.test.js', lineOf(__filename, 'fake')]);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('code outside the application has no origin at all', () => {
  const finder = new OriginFinder(path.join(ROOT, 'src'), 60);
  // Every frame here is in test/, which is outside the code root given above.
  assert.strictEqual(finder.find(), null);
});

test('node internals are never an origin', () => {
  const finder = new OriginFinder(ROOT, 60);
  const origin = new Promise((resolve) => setImmediate(() => resolve(finder.find())));
  return origin.then((found) => {
    assert.ok(found === null || found[0].startsWith('test/'), `got ${JSON.stringify(found)}`);
  });
});

test('reading a stack leaves the process as it was found', () => {
  const finder = new OriginFinder(ROOT, 60);
  const prepare = Error.prepareStackTrace;
  const limit = Error.stackTraceLimit;
  finder.find();
  assert.strictEqual(Error.prepareStackTrace, prepare);
  assert.strictEqual(Error.stackTraceLimit, limit);
  assert.strictEqual(typeof new Error('x').stack, 'string', 'stacks still read as strings');
});

test('the map of known files is bounded', () => {
  const finder = new OriginFinder(ROOT, 60);
  for (let i = 0; i < 5000; i++) finder.isApplication(`/somewhere/file-${i}.js`);
  assert.ok(finder.mine.size <= 4096, `grew to ${finder.mine.size}`);
});

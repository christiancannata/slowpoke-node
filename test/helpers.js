'use strict';

const path = require('node:path');

const slowpoke = require('../src/index');
const { OriginFinder } = require('../src/origin');
const { Tracer } = require('../src/tracer');

const ROOT = path.dirname(__dirname); // packages/node: origins are relative to it in these tests

/** Collects payloads instead of posting them: tests read them back as objects. */
class FakeSender {
  constructor() {
    this.payloads = [];
  }

  send(body) {
    this.payloads.push(body);
    return true;
  }

  async drain() {
    return true;
  }

  decoded() {
    return this.payloads.map((p) => JSON.parse(p));
  }

  /** [root span, query spans] of the only trace sent. */
  onlyTrace() {
    if (this.payloads.length !== 1) {
      throw new Error(`${this.payloads.length} payloads sent, expected 1`);
    }
    return split(this.decoded()[0]);
  }

  trace(i) {
    return split(this.decoded()[i]);
  }
}

function split(payload) {
  const spans = payload.resourceSpans[0].scopeSpans[0].spans;
  return [spans.find((s) => s.kind !== 3), spans.filter((s) => s.kind === 3)];
}

function attr(span, key) {
  const found = (span.attributes || []).find((kv) => kv.key === key);
  return found ? Object.values(found.value)[0] : null;
}

/** A tracer with a fake clock, fake ids and a fake sender: payloads are then comparable. */
function make({ service = 'shop', codeRoot = ROOT, maxQueries = 500 } = {}) {
  const sender = new FakeSender();
  const clock = { now: 1760000000 };
  let n = 0;
  const ids = (bytes) => String(++n).padStart(bytes * 2, bytes === 16 ? 'a' : 'b');
  const tracer = new Tracer({
    origin: new OriginFinder(codeRoot, 60),
    submit: null,
    service,
    version: 'fixture',
    maxQueries,
    clock: () => clock.now,
    ids,
  });
  tracer.submit = (trace) => sender.send(tracer.encodeJson(trace));
  return { tracer, sender, clock };
}

/** Installs a tracer as the package-wide one, for the integrations, and cleans up after the test. */
function install(t, options = {}) {
  const sender = new FakeSender();
  const tracer = slowpoke.configure({ sender, codeRoot: ROOT, service: 'shop', ...options });
  t.after(() => slowpoke.reset());
  return { tracer, sender };
}

/** Line of the statement tagged "// @query <name>" in a file of this package. */
function lineOf(file, name) {
  const lines = require('node:fs').readFileSync(file, 'utf8').split('\n');
  const found = lines.findIndex((line) => line.trimEnd().endsWith(`// @query ${name}`));
  if (found < 0) throw new Error(`no @query ${name} in ${file}`);
  return found + 1;
}

module.exports = { FakeSender, ROOT, attr, split, make, install, lineOf };

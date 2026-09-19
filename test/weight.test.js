'use strict'

// CommonJS like the rest of the package: on Node 18 an import statement in here is a syntax error,
// which is exactly the sort of thing this file exists to catch.
const assert = require('node:assert')
const { execFileSync } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')
const { test } = require('node:test')

const root = path.dirname(__dirname)
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))

// This package runs inside other people's applications. Weight is a promise, so it is a test: the
// day someone reaches for a helper library, or ships the test suite to npm, this fails.
test('it carries nothing into an application that installs it', () => {
  assert.deepStrictEqual(manifest.dependencies ?? {}, {}, 'a runtime dependency would become theirs too')
  assert.deepStrictEqual(manifest.peerDependencies ?? {}, {})
  assert.deepStrictEqual(manifest.optionalDependencies ?? {}, {})
})

test('what npm publishes is the package and nothing else', () => {
  const [packed] = JSON.parse(execFileSync('npm', ['pack', '--dry-run', '--json'], { cwd: root, encoding: 'utf8' }))

  const files = packed.files.map((f) => f.path)
  for (const shipped of files) {
    assert.ok(
      shipped.startsWith('src/') || ['package.json', 'README.md', 'LICENSE', 'SECURITY.md', 'CHANGELOG.md'].includes(shipped),
      `${shipped} has no business in an installed copy`,
    )
  }
  assert.ok(files.some((f) => f === 'src/index.js'), 'the package itself must be in there')
  assert.ok(files.some((f) => f === 'LICENSE'), 'the licence travels with the code')

  // Room to grow, and a wall before it becomes a library nobody reads.
  assert.ok(packed.unpackedSize < 120 * 1024, `unpacked ${Math.round(packed.unpackedSize / 1024)} kB, the limit is 120 kB`)
  assert.ok(packed.entryCount < 30, `${packed.entryCount} files, the limit is 30`)
})

test('it asks for a Node that people actually run, and says so', () => {
  assert.match(manifest.engines.node, /^>=1[0-9]/, 'the oldest Node this package supports is part of the contract')
  assert.strictEqual(manifest.license, 'MIT')
  assert.ok(manifest.files?.length, 'without "files" npm ships whatever is lying around')
})

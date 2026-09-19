'use strict';

const path = require('node:path');

const PACKAGE_DIR = __dirname;

/**
 * The first line of the application's own code on the stack: not the driver, not the ORM, not
 * node_modules, not this package. That line is the whole point of the package.
 */
class OriginFinder {
  constructor(codeRoot, limit = 60) {
    this.codeRoot = codeRoot.endsWith(path.sep) ? codeRoot : codeRoot + path.sep;
    this.limit = Math.max(1, limit);
    // Bounded: one entry per file the process ever runs, never per call.
    this.mine = new Map();
  }

  /** @returns {[string, number]|null} [file relative to the code root, line] */
  find(skipAbove) {
    const previous = Error.prepareStackTrace;
    const limit = Error.stackTraceLimit;
    try {
      Error.prepareStackTrace = (_, frames) => frames;
      Error.stackTraceLimit = this.limit;
      const holder = {};
      Error.captureStackTrace(holder, skipAbove || this.find);
      const frames = holder.stack;
      if (!Array.isArray(frames)) return null;
      for (const frame of frames) {
        const file = typeof frame.getFileName === 'function' ? frame.getFileName() : null;
        if (!file || !this.isApplication(file)) continue;
        const line = typeof frame.getLineNumber === 'function' ? frame.getLineNumber() : null;
        return [path.relative(this.codeRoot, file), line === null ? null : Number(line)];
      }
      return null;
    } catch (e) {
      return null; // a stack we cannot read is one missing origin, never a broken query
    } finally {
      Error.prepareStackTrace = previous;
      Error.stackTraceLimit = limit;
    }
  }

  isApplication(file) {
    let known = this.mine.get(file);
    if (known !== undefined) return known;
    known = !(
      file.startsWith('node:') ||
      !path.isAbsolute(file) ||
      file.includes(`${path.sep}node_modules${path.sep}`) ||
      file.startsWith(PACKAGE_DIR + path.sep) ||
      !file.startsWith(this.codeRoot)
    );
    if (this.mine.size < 4096) this.mine.set(file, known);
    return known;
  }
}

module.exports = { OriginFinder };

'use strict';

const http = require('node:http');
const net = require('node:net');

/**
 * Posts traces to the agent and never gets in the way: plain http to the machine itself or a
 * private network, a hard time budget, a bounded number of requests in flight, every error
 * swallowed. A missing, slow or broken agent costs a trace, never a request.
 */
class HttpSender {
  /** @returns {HttpSender|null} null when the endpoint is not one we may send to */
  static fromUrl(endpoint, timeoutSeconds, maxInFlight = 32) {
    try {
      const url = new URL(endpoint);
      if (url.protocol !== 'http:' || !isPrivate(url.hostname)) return null;
      return new HttpSender(url, timeoutSeconds, maxInFlight);
    } catch (e) {
      return null;
    }
  }

  constructor(url, timeoutSeconds, maxInFlight) {
    this.url = url;
    this.timeout = Math.max(1, Math.round(timeoutSeconds * 1000));
    this.maxInFlight = maxInFlight;
    this.pending = new Set();
    this.agent = new http.Agent({ keepAlive: false, maxSockets: maxInFlight });
  }

  send(body) {
    if (this.pending.size >= this.maxInFlight) return false; // backpressure: drop, never queue
    let done;
    const finished = new Promise((resolve) => { done = resolve; });
    this.pending.add(finished);
    finished.then(() => this.pending.delete(finished), () => this.pending.delete(finished));
    try {
      const request = http.request({
        agent: this.agent,
        protocol: this.url.protocol,
        hostname: this.url.hostname,
        port: this.url.port || 80,
        path: this.url.pathname + this.url.search,
        method: 'POST',
        timeout: this.timeout,
        headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) },
      });
      // The process must never stay alive for a trace: a script exits, slowpoke.flush() waits.
      request.on('socket', (socket) => { if (typeof socket.unref === 'function') socket.unref(); });
      request.on('response', (res) => { res.resume(); res.on('end', done); res.on('error', done); });
      request.on('timeout', () => { request.destroy(); done(); });
      request.on('error', () => done());
      request.end(body);
      return true;
    } catch (e) {
      done();
      return false;
    }
  }

  /** Waits up to `ms` for the traces already sent to reach the agent. */
  async drain(ms = 1000) {
    if (this.pending.size === 0) return true;
    const all = Promise.all([...this.pending]);
    const timer = new Promise((resolve) => setTimeout(resolve, ms).unref?.());
    await Promise.race([all, timer]);
    return this.pending.size === 0;
  }
}

/**
 * The agent lives on the machine or on the private network next to it. A public address would mean
 * a trace with the shape of the application travelling over the internet in plain http.
 */
function isPrivate(hostname) {
  const host = String(hostname).toLowerCase().replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host.endsWith('.localhost')) return true;
  if (host.endsWith('.local') || host.endsWith('.internal') || host.endsWith('.lan')) return true;
  const version = net.isIP(host);
  if (version === 4) {
    const [a, b] = host.split('.').map(Number);
    return a === 127 || a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) ||
      (a === 169 && b === 254) || (a === 100 && b >= 64 && b <= 127);
  }
  if (version === 6) {
    return host === '::1' || host.startsWith('fc') || host.startsWith('fd') || host.startsWith('fe80');
  }
  // A single label, as a Docker or Kubernetes service name: there is no such host on the internet.
  return !host.includes('.');
}

class NullSender {
  send() { return true; }
  async drain() { return true; }
}

module.exports = { HttpSender, NullSender, isPrivate };

<h1 align="center">@slowpoke/node</h1>

<p align="center"><b>Which line of your code is slow. Not which query — which line.</b></p>

<p align="center">
<a href="https://github.com/christiancannata/slowpoke-node/actions/workflows/tests.yml"><img alt="tests" src="https://github.com/christiancannata/slowpoke-node/actions/workflows/tests.yml/badge.svg"></a>
<a href="https://www.npmjs.com/package/@slowpoke/node"><img alt="npm" src="https://img.shields.io/npm/v/@slowpoke/node"></a>
<a href="https://www.npmjs.com/package/@slowpoke/node"><img alt="node" src="https://img.shields.io/node/v/@slowpoke/node"></a>
<a href="https://scorecard.dev/viewer/?uri=github.com/christiancannata/slowpoke-node"><img alt="OpenSSF Scorecard" src="https://api.scorecard.dev/projects/github.com/christiancannata/slowpoke-node/badge"></a>
<a href="LICENSE"><img alt="MIT" src="https://img.shields.io/npm/l/@slowpoke/node"></a>
</p>

---

A slow query tells you *what* is slow. It never tells you **where**, and a tool that points at
`node_modules/pg/lib/client.js:539` has told you nothing at all.

This package sends [Slowpoke](https://github.com/christiancannata/slowpoke) the file and line of **your**
code behind every query — for every request, every job and every command cron runs:

```
GET /orders/:id                                     820 ms · 34 queries
  SELECT * FROM orders WHERE id = $1                  4 ms   src/routes/orders.js:42
  SELECT name FROM customers WHERE id = $1            3 ms   src/models/order.js:88   ← ×31, one per order
  SELECT sum(total) FROM invoices WHERE order_id = $1  9 ms  src/services/billing.js:17
```

That last column is the whole point. Slowpoke turns it into N+1 detection and missions that name a file,
each with a price in seconds of waiting per day — so the argument about what to fix first is over.

**Your ORM comes for free.** The instrumentation sits on `pg` and `mysql2`, which is where TypeORM,
Sequelize, Knex and Drizzle end up: no adapter per ORM, no patch per version.

**Jobs and cron too.** A BullMQ job and a nightly script are not endpoints, and the package does not
pretend they are: they go to the Jobs page with how long they took, how often they failed and the same
`file:line` for their queries. Nobody is waiting for them, which is exactly why nobody notices when they
get slower.

## Install

```sh
npm install @slowpoke/node
```

No SDK, no native module, no key to carry, no account anywhere. The package talks to the Slowpoke agent
on the same machine, which needs one line in `/etc/slowpoke/agent.yaml`:

```yaml
sources:
  - type: otlp          # the agent listens on 127.0.0.1:4318
```

### Express

```js
const slowpoke = require('@slowpoke/node');

slowpoke.pg.instrument();          // or slowpoke.mysql2.instrument()
app.use(slowpoke.express());       // first, so the timing covers the other middleware
```

### Fastify

```js
const slowpoke = require('@slowpoke/node');

slowpoke.pg.instrument();
await app.register(slowpoke.fastify);
```

### BullMQ, cron, scripts

```js
new Worker('emails', slowpoke.bullmq.processor(async (job) => { ... }));

await slowpoke.command('close-orders', async () => { ... });     // what cron runs
await slowpoke.job('rebuild-index', async () => { ... }, { queue: 'nightly' });
```

A short script can `await slowpoke.flush()` before exiting; a server never needs to.

## Performance

The rule this package is built on is the one the whole project follows: **never make the application
slower**. Measured, not claimed, and you can run it yourself with `./bin/bench` — everything the package
does *while a request is running*: timing each query, finding the line behind it, building the trace.

| a request with 50 queries | Node 18 | Node 22 |
|---|---|---|
| 50 times the same statement (an N+1) | **0.05 ms** | **0.06 ms** |
| 50 different statements | **1.5 ms** | **1.6 ms** |

Reading a stack is by far the most expensive thing here, about 30 µs, so it is read **once per distinct
statement per request**: the thirty-one repeats of an N+1 cost one stack, not thirty-one — and they all
point at the same line anyway. Everything else is about 0.4 µs per query.

| | |
|---|---|
| **Sent after the response** | the trace leaves on `finish`, when the client already has the page. Jobs and commands send as soon as they are done |
| **Never waits** | the socket is unref'd and has a hard time budget (`SLOWPOKE_TIMEOUT`, 0.1 s), with a bounded number of requests in flight: past that a trace is dropped, never queued. A missing, slow or broken agent costs one trace, never a request — and never keeps your process alive |
| **Never copies your data** | the stack is read for file and line only: no argument, no local, ever |
| **Bounded** | 500 queries described per request at most, the rest counted; statements over 10 000 characters cut; bounded maps everywhere |
| **Quiet when idle** | a query outside a request, a job or a command — a pool warming up, a migration — costs one lookup and is not recorded |
| **Right under load** | the trace lives in `AsyncLocalStorage`: a thousand requests in flight never mix their queries, and there is a test that runs them at once to prove it |

About 800 lines of JavaScript. **No runtime dependency at all.**

## What is sent, and what never is

Sent only to the agent on your machine or private network:

- **per request** — method, route template (`/orders/:id`), status code, start and end time. When no
  route matched, the path without its query string;
- **per job** — the job name, the queue it came from, whether it threw;
- **per command** — the command name, how long it took, whether it threw;
- **per query** — the SQL **with placeholders** exactly as the driver received it, the database engine,
  the real duration, and the first line of your own code on the stack, outside `node_modules`, outside
  Node's internals and outside this package.

**Never sent** — parameter values, request bodies, headers, cookies, session, the user, error messages.
If you build SQL with literal values yourself, they are part of the statement, and the agent redacts them
before anything leaves the machine.

## Configuration

Everything has a default that works. Nothing has to be set.

| Variable | Default | |
|---|---|---|
| `SLOWPOKE_ENABLED` | `true` | `false` turns everything off: nothing recorded, nothing sent |
| `SLOWPOKE_OTLP_ENDPOINT` | `http://127.0.0.1:4318/v1/traces` | plain http to a local or private host only (private ranges, `localhost`, a Docker or Kubernetes service name, `.local`/`.internal`); anything else disables the package |
| `SLOWPOKE_TIMEOUT` | `0.1` | seconds given to the agent, connect and write together |
| `SLOWPOKE_SERVICE` | the code root folder's name | the name of this application in Slowpoke |
| `SLOWPOKE_MAX_QUERIES` | `500` | queries described per request, job or command; the rest are counted |
| `SLOWPOKE_MAX_SQL_LENGTH` | `10000` | longer statements are cut |
| `SLOWPOKE_BACKTRACE_LIMIT` | `60` | stack frames inspected to find your line |
| `SLOWPOKE_CODE_ROOT` | the working directory | file paths are sent relative to it |
| `SLOWPOKE_MAX_IN_FLIGHT` | `32` | traces on their way to the agent at once; past that they are dropped |

The same settings can be passed in code: `slowpoke.configure({ service: 'shop', codeRoot: '/srv/app' })`.

## Compatibility

| | |
|---|---|
| **Node** | 18, 20, 22, 24 |
| **Requests** | Express 4 and 5, Fastify 4 and 5 |
| **Queries** | `pg` 8 and `mysql2` 3 — and with them TypeORM, Sequelize, Knex and Drizzle, which run on top |
| **Jobs** | BullMQ, or your own worker with `slowpoke.job` |

Prisma talks to its own engine rather than to a driver, so it is not covered yet.

## Quality

| | |
|---|---|
| **46 tests** | unit tests, and integration tests on real Express and Fastify applications, on Node 18 to 24 |
| **Same wire, both sides** | `spec/node_otlp_fixtures.json` in the Slowpoke repository holds payloads exactly as this package sends them, with what the agent must read from each. The agent's Go tests replay that file: a change here the agent cannot read fails there |
| **`npm audit`** and **CodeQL** | in CI, on every push, on the code and on the workflows, which are pinned by commit |
| **Signed provenance** | every release archive carries a Sigstore attestation |

```sh
./bin/test 22                                    # the suite on Node 22
./bin/test 18                                    # and on the oldest supported Node
./bin/test 22 test/express.test.js               # one file
./bin/bench                                      # the numbers in Performance, on your machine
```

Everything runs in Docker. Nothing is installed on your machine.

## Security

It reads no request data, sends nothing outside your machine or private network, and cannot break or slow
a request. What it does and never does, how to report a vulnerability and how to verify a release are in
[SECURITY.md](SECURITY.md).

Do not run it together with OpenTelemetry auto-instrumentation pointed at the same agent: every request
and query would arrive twice. This package replaces it, and gives the origin it cannot.

## License

MIT, see [LICENSE](LICENSE). Slowpoke itself is free and self-hosted: the measures stay on your machines,
and nothing about your application ever leaves them.

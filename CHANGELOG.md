# Changelog

## 0.1.5 - 2026-09-21

- A BullMQ (or Bull 3) job without a real name is named after its queue on the Jobs page. Bull 3 calls
  a job added without a name `__default__`, and an empty name fell back to the job id, which is
  different on every run (`repeat:<key>:<timestamp>` for a repeatable job): each run became a row of
  its own. The id is never used as a name any more.

## 0.1.4 - 2026-09-21

- Outbound HTTP calls made with `fetch`, `undici`, `http` or `https` during a request, a job or a
  command are now part of its trace: one span per call with the method, the remote host (the port only
  when it is not the scheme's default), the status, the time spent waiting and the line of your code
  that made it, so Slowpoke can say "this endpoint waits 8 s on api.stripe.com". A failed connection, an
  abort and a 5xx answer are errors. The URL path, the query string, headers and bodies are never sent.
  A fetch is counted once, redirects included. `SLOWPOKE_HTTP_CLIENT=false` (or
  `configure({ httpClient: false })`) turns it off and `SLOWPOKE_MAX_HTTP_CALLS` (200) bounds the calls
  described per trace, the rest are counted (`slowpoke.dropped_http_calls`).

## 0.1.3 - 2026-09-20

- **Queries run through a connection pool were being lost - nine out of ten of them.** A pool does
  not answer on the spot: it queues the statement and calls back when a connection frees up, from
  whatever context its queue was drained in. The query was then filed by looking up "the request
  running now", which by then was another request or none, so it was dropped. The trace is now
  taken when the application asks and travels with the statement, and the driver's callback - which
  is the application's own code - is resumed inside the request that asked for it, so a statement
  issued from inside another one's callback is recorded too. Anything using `mysql2` (its promise
  wrapper included, so every ORM on top of it) or `pg` with callbacks was affected; the lab caught
  it with 161 requests reporting 0 queries.
- The package says which host it answered for (`server.address`). With a web server in front of the
  application on **another machine** - an ingress, a load balancer, containers elsewhere - no agent
  sees both the access log and the traces, so until now the same requests were counted twice: in the
  traffic, in the speed index and in the technical debt built from them. The host is what links the
  two sides; on one machine the agent already paired single requests and still does.

## 0.1.2 - 2026-09-19

- Releases come from GitHub Actions through OpenID Connect: no token in a secret, none on a laptop,
  and npm records which workflow of which repository built each version, with a provenance
  attestation attached.
- A tag does not publish: it **stages**. The version waits on npmjs.com until a person approves it,
  which is the right gate for something that runs inside other people's applications.

## 0.1.1 - 2026-09-19

- The name on npm is **@slowpokedev/node**: the scope belongs to the slowpokedev organisation, and
  everything published for Node will live under it. Nothing changes in the code.
- Weight is a test now: no dependency of any kind, a published copy that is source and documentation
  only - checked file by file with a wall at 120 kB - and a wall on the size of `src/`.

## 0.1.0 - 2026-09-18

First release.

- Every request is one trace: the route template (`/orders/:id`), the status, and each query with
  the `file:line` of the application code that ran it. Express and Fastify for requests, `pg` and
  `mysql2` for queries - which is also how the ORMs on top of them are covered (TypeORM, Sequelize,
  Knex, Drizzle).
- The N+1 that hides in a loop is visible as what it is: the same statement, counted, with the one
  line behind it. Reading a stack is the expensive part, so it is read once per distinct statement
  per request: an N+1 of thirty repeats costs one.
- Work nobody waits for is traced too: BullMQ jobs, and anything wrapped in `slowpoke.job` or
  `slowpoke.command`, which is what cron runs.
- Node 18 and later. No runtime dependency at all.
- Statement text only, never the parameter values. Plain `http` to the agent on the same machine or
  a private network, with a bounded number of requests in flight and unref'd sockets: a missing or
  slow agent costs a trace, never a request, and never keeps a process alive.

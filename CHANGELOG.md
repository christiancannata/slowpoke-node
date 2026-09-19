# Changelog

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

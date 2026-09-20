# Security

## Reporting a vulnerability

Please do not open a public issue. Report it privately through
[GitHub security advisories](https://github.com/christiancannata/slowpoke-node/security/advisories/new),
or write to christiancannata@gmail.com. Reports are answered as soon as possible, and fixed releases credit the reporter unless asked otherwise.

## Supported versions

The latest 0.x release receives security fixes.

## What this package does, and what it never does

It runs inside your application, so it is kept small and easy to read (about 800 lines in `src/`).

- It only **reads** what the framework and the driver already expose: the matched route, the response status, the
  SQL text handed to the driver, and the stack (file and line only, never a local or an argument) to find the
  application line.
- Of the request it reads the method, the route template, the response status and the **host** it was
  addressed to (the name in the `Host` header, without the port: `shop.example.com`), which is what lets
  a web server in front of the application on another machine be recognised as reporting the same
  requests instead of counting them twice.
- It **never reads** binding values, request parameters, any other header, cookies, sessions, users or
  exception messages.
- It **sends** one trace per request, job or command, after the response, only to a plain `http://` address on the
  same machine or a private network (`127.0.0.1:4318` by default). Public addresses are refused.
- It has a hard 0.1 s budget and swallows every error: a missing or broken agent can never break or slow a request.
- It does not write files, run shell commands, load remote code or phone home. It has **no runtime dependency at all**: the
  standard library of Node and nothing else.

## How releases can be verified

- Every push runs the test suite on Node 18 to 24 with Express, Fastify, pg and mysql2, plus `npm audit`.
- The repository is scored by [OpenSSF Scorecard](https://scorecard.dev/viewer/?uri=github.com/christiancannata/slowpoke-node).
- Release archives carry a signed build provenance (Sigstore). To verify one:

  ```sh
  gh attestation verify slowpoke-node-v0.1.0.zip --repo christiancannata/slowpoke-node
  ```

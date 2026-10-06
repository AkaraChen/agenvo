# Contributing

[简体中文](CONTRIBUTING.zh-CN.md)

Use Node.js 24.13+ and `npm ci`. Keep changes focused and explain the user-visible behavior. Code, identifiers and comments use English. Design documents use Chinese. User guides must have matching English and Simplified Chinese versions; update both when behavior changes.

```sh
npm ci
npm run check
npm run build
npm test
npm run test:integration
npm run format:check
npm audit
```

Integration tests start local workerd and Node servers with temporary state, exercise real HTTP/WebSocket/MCP routes and do not require a Cloudflare account. Unit tests use deterministic native-server fixtures where appropriate. Keep private configuration, credentials, native logs and generated build outputs out of Git.

Optional native validation requires Herdr 0.9.3, Codex CLI 0.160.1 and their normal platform prerequisites:

```sh
npm run test:adapters
npm run test:e2e
```

These checks create isolated test environments. Linux user-service coverage additionally needs a working systemd user manager. Read the test prerequisites and skipped-test output before claiming native coverage. Never point tests at an everyday runtime or production relay. The Codex schema generator (`scripts/import-codex-schema.py`) must be run against the explicitly supported CLI version, followed by policy and adapter validation.

Source responsibilities:

- `src/protocol`: transport schemas, limits and execution outcomes.
- `src/relay`: portable routing core, MCP and Cloudflare host.
- `src/server`: single-process VPS host, SQLite and OAuth.
- `src/connector`: device lifecycle and native runtime adapters.
- `src/cli`: configuration, owner commands and service/deployment integration.

New deployment hosts must reuse the routing core and preserve authorization, epoch and uncertain-execution semantics. Native adapter additions require discoverable schemas and meaningful input/approval boundaries. Do not add retry mechanisms that can duplicate writes.

Before sending a change, review the diff for private paths and credentials, run relevant tests, and state validation gaps. Use commits that each express one coherent behavior. Do not include generated schema or dependency updates without explaining their source and necessity.

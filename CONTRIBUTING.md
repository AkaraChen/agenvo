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

Native tests use isolated Herdr/Codex environments and a local model endpoint, without external inference. `test:e2e` can use an isolated `AGENVO_E2E_CODEX_HOME`; never point it at an everyday home or production service. Linux user-service tests require a systemd user manager; check skipped-test output for actual coverage.

When updating Codex schemas, run `scripts/import-codex-schema.py` against the supported CLI version and validate execution settings and adapters.

Source responsibilities:

- `src/protocol`: transport schemas, limits and execution outcomes.
- `src/relay`: portable routing core, MCP and Cloudflare host.
- `src/server`: single-process VPS host, SQLite and OAuth.
- `src/connector`: device lifecycle and native runtime adapters.
- `src/cli`: runtime configuration, optional administrator commands and Connector service integration.

New deployment hosts must reuse the routing core and preserve authorization, epoch and uncertain-execution semantics. Native adapter additions require discoverable schemas and explicit capability and interaction semantics. Do not add retry mechanisms that can duplicate writes.

Before sending a change, review the diff for private paths and credentials, run relevant tests, and state validation gaps. Use commits that each express one coherent behavior. Do not include generated schema or dependency updates without explaining their source and necessity.

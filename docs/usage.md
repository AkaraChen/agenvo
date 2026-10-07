# Connect devices and clients

[简体中文](usage.zh-CN.md) · [README](../README.md)

Commands below assume a deployed `https://relay.example.com`. The owner and devices can be different machines. `AGENVO_CONFIG_DIR` selects an installation; it defaults to `~/.config/agenvo`. Do not share this directory between simultaneous Connector processes.

Web pages follow the browser’s language preferences (`Accept-Language`): Chinese preferences use Simplified Chinese, English preferences use English, and unmatched preferences fall back to English. Each page displays one language.

## Configure a runtime

Start Herdr independently using Herdr's own application/service, then share its entire configuration environment:

```sh
agenvo instance add herdr --id work --config-root "$HOME/.config/herdr" --cwd "$HOME/code"
```

The directory must be the native directory named `herdr`. The Connector discovers its running sessions and can create workspaces and agents there. It has no `session.start` or `session.stop` method. Stopping the Connector leaves Herdr running.

For an isolated, Connector-managed Codex app-server:

```sh
mkdir -p "$HOME/.config/agenvo/codex/coding"
CODEX_HOME="$HOME/.config/agenvo/codex/coding" codex login
agenvo instance add codex --id coding --home "$HOME/.config/agenvo/codex/coding" --cwd "$HOME/code"
```

Codex work always uses `danger-full-access` and `approvalPolicy: never`, including thread creation, resume and new input through attach mode. Execution permission requests are answered automatically. The old sandbox/approval-policy CLI options have been removed; legacy `policy` configuration is discarded when loaded. User questions and dynamic tool calls remain explicit interactions.

Experimental `--mode attach-unix --socket /absolute/control.sock` connects to an existing Codex control endpoint. It never starts or stops that server and applies full access to work submitted through Agenvo. A standard desktop App's existing stdio process does not automatically provide such an endpoint. Agenvo does not reconfigure or restart the desktop App. Only use attach mode when you have independently provisioned and tested a compatible endpoint; managed mode is the normal setup.

## Pair and run

```sh
agenvo connect https://relay.example.com --name laptop
```

The command opens the management page and waits. Sign in with the administrator key, compare the device fingerprint and listed instances with the terminal, and approve. Pairing completes automatically; use `agenvo run` or `agenvo service install` next. Headless devices can use `--no-browser` and open the printed approvalUrl on another computer. With `--no-wait`, run connect again after approval. Ordinary devices do not need the administrator key. Linux services require operator-configured linger to survive logout.

After changing instances, restart the Connector and approve the new scope in `/admin`. The same page revokes devices, instances and client grants.

## Authorize MCP clients

Add `https://relay.example.com/mcp` in a client supporting dynamic OAuth registration, S256 PKCE and Streamable HTTP. Sign in on Agenvo's page, review the client, callback and scope, then allow access. The browser returns to the client automatically. No authorization URL copying, approval command or callback file is required. Access tokens last 15 minutes; grants last up to 30 days. All authorized clients can access every approved instance.

## Optional administrator automation

Inject `AGENVO_ADMIN_SECRET` securely into an explicit administration command's environment. Do not put it in Connector configuration, service definitions or command-line arguments. Available commands include:

```sh
agenvo pairing list --origin https://relay.example.com
agenvo pairing approve CODE --fingerprint SHA256 --origin https://relay.example.com
agenvo admin state --origin https://relay.example.com
agenvo admin approve-instance --device-id DEVICE --instance-id INSTANCE --fingerprint SHA256 --origin https://relay.example.com
```

`connect --approve` is only for trusted administrator terminals with an explicitly supplied administrator key. Approve remote devices from the administrator terminal without sending that key to the device.

Use [Managing Agent threads](management.md) for the common management API. Discover advertised methods before calling them; native methods remain available for service-specific work. Use `management.threads.*` with the returned `threadRef`; poll `threads.observe` for current state, output and pending interactions. Query uncertain writes instead of resending them, and inspect observation gaps. Herdr `idle` is not proof of task completion.

## Revoke and diagnose

```sh
agenvo admin revoke grant --id GRANT_ID --origin https://relay.example.com
agenvo admin revoke instance --id DEVICE_ID --instance-id INSTANCE_ID --origin https://relay.example.com
agenvo admin revoke device --id DEVICE_ID --origin https://relay.example.com
agenvo status --json
agenvo doctor
agenvo disconnect
```

Revocation blocks new access and delivery of pending results. It does not undo or stop local work already dispatched. `disconnect` clears local credentials and attempts cloud revocation; check its `cloudRevoked` and `serviceUninstalled` fields. If cloud revocation failed, revoke the device with the owner CLI when connectivity returns.

A crashed Connector may leave `run.lock`. Verify that its process is gone before `agenvo doctor --recover-lock`. Never delete a live process's lock. When a call reports `unknown`, inspect the native runtime before retrying a write. Connector restarts invalidate pending input handles; rediscover native state rather than replaying an old answer.

Codex 0.160.1 may reject `thread/turns/list` or `thread/read` with `includeTurns: true` with `list_turns is not supported yet`. Use `thread/read` without `includeTurns` for metadata. Native capability schemas do not guarantee every optional backend feature is implemented.

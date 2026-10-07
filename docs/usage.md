# Connect devices and clients

[简体中文](usage.zh-CN.md) · [README](../README.md)

Commands below assume a deployed `https://relay.example.com`. The owner and devices can be different machines. `AGENVO_CONFIG_DIR` selects an installation; it defaults to `~/.config/agenvo`. Do not share this directory between simultaneous Connector processes.

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

On the device:

```sh
agenvo connect https://relay.example.com --name laptop --no-browser
```

Keep this command running. It prints a code and fingerprint. On the owner machine:

```sh
agenvo pairing list --origin https://relay.example.com
agenvo pairing approve CODE --fingerprint SHA256 --origin https://relay.example.com
```

Compare the fingerprint with the device terminal, not only the pending request list. Initial approval covers the displayed instances. The device's command finishes after approval; run `agenvo run`, or `agenvo service install` for launchd on macOS/systemd user service on Linux. On Linux, logout persistence requires the administrator to enable linger; Agenvo does not change that host policy.

After adding or changing instances, restart the Connector and inspect the new scope:

```sh
agenvo admin state --origin https://relay.example.com
agenvo admin approve-instance --device-id DEVICE --instance-id INSTANCE \
  --fingerprint SHA256 --origin https://relay.example.com
```

## Authorize the MCP client

Add `https://relay.example.com/mcp` in a client supporting OAuth dynamic client registration, authorization-code flow with S256 PKCE, and Streamable HTTP. When it opens an authorization URL, use the owner CLI:

```sh
agenvo client inspect 'AUTHORIZATION_URL' --origin https://relay.example.com
agenvo client approve 'AUTHORIZATION_URL' --origin https://relay.example.com \
  --client-id CLIENT_ID --redirect-uri 'EXACT_REDIRECT_URI' --output /private/path/consent.json
```

Inspect the client identity and exact callback before approving. Open the `redirectTo` URL in the saved mode-0600 file to finish the original client's login. It contains a short-lived authorization code: do not paste it into chat, logs or Git. The output path must not already exist. Access tokens last 15 minutes; grants expire after 30 days or owner revocation. All approved runtime instances are included; grants are not per-project or per-device.

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

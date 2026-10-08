# Connect devices and clients

[简体中文](usage.zh-CN.md) · [README](../README.md)

Commands below assume a deployed `https://relay.example.com`. The owner and devices can be different machines. `AGENVO_CONFIG_DIR` selects an installation; it defaults to `~/.config/agenvo/herdr` for Herdr and `~/.config/agenvo/codex-app-server` for Codex. Do not share this directory between simultaneous Connector processes.

If the connector commands are not installed, follow [installation](installation.md) first.

## Configure a runtime

Start Herdr independently using Herdr's own application/service, then share its entire configuration environment:

```sh
agenvo-herdr instance add --id work --config-root "$HOME/.config/herdr" --cwd "$HOME/code"
```

The path must point to the native directory named `herdr`. The Connector discovers its running sessions; stopping it leaves Herdr running.

For an isolated, Connector-managed Codex app-server:

```sh
mkdir -p "$HOME/.config/agenvo/codex-app-server/codex/coding"
CODEX_HOME="$HOME/.config/agenvo/codex-app-server/codex/coding" codex login
agenvo-codex-app-server instance add --id coding --home "$HOME/.config/agenvo/codex-app-server/codex/coding" --cwd "$HOME/code"
```

Codex work always uses `danger-full-access` and `approvalPolicy: never`, including thread creation, resume and new input through attach mode. Execution permission requests are answered automatically. User questions and dynamic tool calls remain explicit interactions.

On macOS/Linux, experimental `--mode attach-unix --socket /absolute/control.sock` requires an independently provisioned, compatible Codex control endpoint. A desktop App's stdio process does not provide one automatically. Attach mode never starts or stops that server; managed mode above is the default.

On Windows, use PowerShell and the installed native Herdr/Codex commands (including npm command shims). Herdr normally stores its configuration in `$env:APPDATA/herdr`; pass the actual directory to `--config-root`. For an isolated Codex home:

```powershell
$env:CODEX_HOME = "$HOME/.config/agenvo/codex-app-server/codex/coding"
New-Item -ItemType Directory -Force $env:CODEX_HOME | Out-Null
codex login
agenvo-codex-app-server instance add --id coding --home $env:CODEX_HOME --cwd "$HOME/code"
```

Windows uses `managed-stdio`; `attach-unix` requires a Unix socket. Keep configuration in your user profile, protected by Windows directory ACLs. POSIX permission-bit checks do not apply on Windows.

## Pair and run

The examples use Herdr. For Codex, use `agenvo-codex-app-server` and pair it separately. Both can run on the same computer, with separate configuration, credentials, and services. Do not copy pairing credentials between them. The wire field `deviceId` identifies a Connector, not a physical computer.

```sh
agenvo-herdr connect https://relay.example.com --name laptop
```

The command opens the management page and waits. Sign in with the administrator key, compare the device fingerprint and instances with the terminal, and approve. After pairing, run `agenvo-herdr run` in the foreground or, on macOS/Linux, `agenvo-herdr service install` for a background service. Windows currently uses the foreground `run` command; the CLI does not install a Windows service.

On a headless device, use `--no-browser` and open the printed approval URL on another computer. The device does not need the administrator key. With `--no-wait`, run connect again after approval. Linux user services require linger to survive logout.

After changing instances, restart the Connector and approve the new scope in `/admin`. The same page revokes devices, instances and client grants.

## Authorize MCP clients

Add `https://relay.example.com/mcp` in a client supporting dynamic OAuth registration, S256 PKCE and Streamable HTTP. Sign in on Agenvo's page, review the client, callback and scope, then allow access. The browser returns to the client automatically. Access tokens last 15 minutes; grants last up to 30 days. All authorized clients can access every approved instance.

## Optional administrator automation

Inject `AGENVO_ADMIN_SECRET` securely into an explicit administration command's environment. Do not put it in Connector configuration, service definitions or command-line arguments. Available commands include:

```sh
agenvo-herdr pairing list --origin https://relay.example.com
agenvo-herdr pairing approve CODE --fingerprint SHA256 --origin https://relay.example.com
agenvo-herdr admin state --origin https://relay.example.com
agenvo-herdr admin approve-instance --device-id DEVICE --instance-id INSTANCE --fingerprint SHA256 --origin https://relay.example.com
```

`connect --approve` is only for trusted administrator terminals with an explicitly supplied administrator key. Approve remote devices from the administrator terminal without sending that key to the device.

For task operations, see [Managing Agent threads](management.md).

## Revoke and diagnose

```sh
agenvo-herdr admin revoke grant --id GRANT_ID --origin https://relay.example.com
agenvo-herdr admin revoke instance --id DEVICE_ID --instance-id INSTANCE_ID --origin https://relay.example.com
agenvo-herdr admin revoke device --id DEVICE_ID --origin https://relay.example.com
agenvo-herdr status --json
agenvo-herdr doctor
agenvo-herdr disconnect
```

Revocation blocks new access and delivery of pending results. It does not undo or stop local work already dispatched. `disconnect` clears local credentials and attempts cloud revocation; check its `cloudRevoked` and `serviceUninstalled` fields. If cloud revocation failed, revoke the device with the owner CLI when connectivity returns.

A crashed Connector may leave `run.lock`. Verify that its process is gone before `agenvo-herdr doctor --recover-lock`. Never delete a live process's lock. When a call reports `unknown`, inspect the native runtime before retrying a write. Connector restarts invalidate pending input handles; rediscover native state rather than replaying an old answer.

Codex 0.160.1 may reject `thread/turns/list` or `thread/read` with `includeTurns: true` with `list_turns is not supported yet`. Use `thread/read` without `includeTurns` for metadata.

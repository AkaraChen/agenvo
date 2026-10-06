# Connect devices and clients

[简体中文](usage.zh-CN.md) · [README](../README.md)

Commands below assume a deployed `https://relay.example.com`. The owner and devices can be different machines. `SIYIN_CONFIG_DIR` selects an installation; it defaults to `~/.config/siyin`. Do not share this directory between simultaneous Connector processes.

## Configure a runtime

Start Herdr independently using Herdr's own application/service, then share its entire configuration environment:

```sh
siyin instance add herdr --id work --config-root "$HOME/.config/herdr" --cwd "$HOME/code"
```

The directory must be the native directory named `herdr`. The Connector discovers its running sessions and can create workspaces and agents there. It has no `session.start` or `session.stop` method. Stopping the Connector leaves Herdr running.

For an isolated, Connector-managed Codex app-server:

```sh
mkdir -p "$HOME/.config/siyin/codex/coding"
CODEX_HOME="$HOME/.config/siyin/codex/coding" codex login
siyin instance add codex --id coding --home "$HOME/.config/siyin/codex/coding" --cwd "$HOME/code" --sandbox read-only
```

Create the home directory first if your Codex login requires it. `--sandbox workspace-write` and `--approval-policy untrusted|on-request` configure the managed instance's local ceiling. Review native permissions before changing them. Remote requests cannot raise that ceiling.

Experimental `--mode attach-unix --socket /absolute/control.sock` connects to an existing Codex control endpoint. It never starts or stops that server and preserves its native thread permissions. A standard desktop App's existing stdio process does not automatically provide such an endpoint. Siyin does not reconfigure or restart the desktop App. Only use attach mode when you have independently provisioned and tested a compatible endpoint; managed mode is the normal setup.

## Pair and run

On the device:

```sh
siyin connect https://relay.example.com --name laptop --no-browser
```

Keep this command running. It prints a code and fingerprint. On the owner machine:

```sh
siyin pairing list --origin https://relay.example.com
siyin pairing approve CODE --fingerprint SHA256 --origin https://relay.example.com
```

Compare the fingerprint with the device terminal, not only the pending request list. Initial approval covers the displayed instances. The device's command finishes after approval; run `siyin run`, or `siyin service install` for launchd on macOS/systemd user service on Linux. On Linux, logout persistence requires the administrator to enable linger; Siyin does not change that host policy.

After adding or changing instances, restart the Connector and inspect the new scope:

```sh
siyin admin state --origin https://relay.example.com
siyin admin approve-instance --device-id DEVICE --instance-id INSTANCE \
  --fingerprint SHA256 --origin https://relay.example.com
```

## Authorize the MCP client

Add `https://relay.example.com/mcp` in a client supporting OAuth dynamic client registration, authorization-code flow with S256 PKCE, and Streamable HTTP. When it opens an authorization URL, use the owner CLI:

```sh
siyin client inspect 'AUTHORIZATION_URL' --origin https://relay.example.com
siyin client approve 'AUTHORIZATION_URL' --origin https://relay.example.com \
  --client-id CLIENT_ID --redirect-uri 'EXACT_REDIRECT_URI' --output /private/path/consent.json
```

Inspect the client identity and exact callback before approving. Open the `redirectTo` URL in the saved mode-0600 file to finish the original client's login. It contains a short-lived authorization code: do not paste it into chat, logs or Git. The output path must not already exist. Access tokens last 15 minutes; grants expire after 30 days or owner revocation. All approved runtime instances are included; grants are not per-project or per-device.

MCP workflows: list instances, describe the selected instance's methods, then call an advertised method. Preserve native IDs returned by writes. Use native agent/thread state and output to monitor work. Herdr `idle` is not proof of task completion. Structured Codex input/approval requests are supported where advertised; Herdr uses native terminal interactions. Do not treat absent input as consent.

## Revoke and diagnose

```sh
siyin admin revoke grant --id GRANT_ID --origin https://relay.example.com
siyin admin revoke instance --id DEVICE_ID --instance-id INSTANCE_ID --origin https://relay.example.com
siyin admin revoke device --id DEVICE_ID --origin https://relay.example.com
siyin status --json
siyin doctor
siyin disconnect
```

Revocation blocks new access and delivery of pending results. It does not undo or stop local work already dispatched. `disconnect` clears local credentials and attempts cloud revocation; check its `cloudRevoked` and `serviceUninstalled` fields. If cloud revocation failed, revoke the device with the owner CLI when connectivity returns.

A crashed Connector may leave `run.lock`. Verify that its process is gone before `siyin doctor --recover-lock`. Never delete a live process's lock. When a call reports `unknown`, inspect the native runtime before retrying a write. Connector restarts invalidate pending input handles; rediscover native state rather than replaying an old answer.

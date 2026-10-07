# Migrating from Siyin

[简体中文](migration.zh-CN.md)

Agenvo is the new name of the Siyin MCP relay. This repository continues the relay's history. The unrelated earlier Agenvo project is preserved in [agenvo-legacy](https://github.com/Xuanwo/agenvo-legacy); its binaries and configuration are not compatible with this relay. Build this checkout and inspect `node dist/cli.js --help` before replacing any existing `agenvo` command.

## New installations

Use `agenvo`, `AGENVO_CONFIG_DIR` (default `~/.config/agenvo`), and the Agenvo deployment guides. Copy `wrangler.jsonc` to a private local manifest; the VPS Compose domain variable is `AGENVO_DOMAIN`. Connector user services use the `io.agenvo.connector.` prefix.

## Existing installations

Renaming a repository does not upgrade a deployed relay or restart a Connector. Keep your existing deployment running until you choose an upgrade window. Building the new checkout does not modify installed services.

Keep the same origin, device configuration, runtime paths, state directory, and Cloudflare resource IDs. The three MCP tools and protocol version 1 are unchanged. Wire headers, heartbeat messages, `siyin.describe`, serialized fault names, the `SiyinRelay` Durable Object class, and the VPS `siyin.sqlite` filename retain their existing identities. These strings are compatibility identifiers, not unfinished branding changes.

### Owner and Connector configuration

Explicitly select the existing configuration directory:

```sh
export AGENVO_CONFIG_DIR="$HOME/.config/siyin"
node /absolute/path/to/agenvo/dist/cli.js status --json
```

Configuration selection is `AGENVO_CONFIG_DIR`, then the legacy `SIYIN_CONFIG_DIR`, then `~/.config/agenvo`. Agenvo does not automatically discover or copy `~/.config/siyin`. Do not change the configured Codex homes or Herdr roots merely to rename the project.

For a service upgrade, finish active managed Codex turns first. Use the old CLI and the old configuration directory to run `service uninstall`; this stops the old `io.siyin.connector.*` service. Then use the new CLI with `AGENVO_CONFIG_DIR` pointing to that same directory to run `service install`. A manually started Connector must also be stopped before replacement. Never run both services against the same configuration. Herdr itself remains independently running; stopping a managed Codex Connector stops its managed processes. If the old CLI is unavailable, stop and remove its exact launchd/systemd unit before installing the new service.

### Cloudflare

Preserve the Worker name, ORIGIN, KV ID, DO binding and migration history. Point the old manifest's `main` at the new checkout's `src/relay/worker.ts`. Remove `OWNER_PUBLIC_KEY`, `OWNER_EMAIL`, `ACCESS_ISSUER` and `ACCESS_AUD`, and set `secrets.required` to `["ADMIN_SECRET"]`. Inject the new administrator key with Wrangler secrets and deploy with `npx wrangler deploy --config EXISTING_MANIFEST`. Remove old Access login interception and verify built-in login at `/admin`.

Do not recreate storage for an upgrade. With the same ORIGIN, existing device credentials and OAuth grants remain valid; owner signing keys are no longer accepted. A domain change is a separate migration requiring client reconfiguration and acceptance.

### Single VPS

Stop the old Relay and back up the full state directory before switching the executable. Reuse the existing Relay JSON configuration, origin, data directory, and `siyin.sqlite` file, including its WAL/SHM files. Only one process may own the database. When replacing a Compose checkout, preserve the Compose project name and volume mappings so it mounts the original data and Caddy volumes; set `AGENVO_DOMAIN` to the existing domain. For systemd, update the installed unit's executable path without changing its user or state permissions. The new `agenvo.service` template is intended for new installations, not a replacement for an existing deployment's paths.

After upgrading, check `/health`, inspect `agenvo admin state --origin https://YOUR_EXISTING_RELAY`, and verify `instances_list` from the existing MCP client. The health response now identifies the service as `agenvo`. Check native state before retrying any write whose result became uncertain during the upgrade.

## Administrator authentication upgrade

For VPS, remove `ownerPublicKey` from the JSON configuration, set `AGENVO_ADMIN_SECRET` in the process environment and restart. Preserve other configuration and the data directory. Administrators sign in through the browser; explicit CLI administration uses the same key in its environment. `agenvo deploy` and `agenvo client login/inspect/approve/call` have been removed: use platform deployment tools and the original MCP client's browser OAuth flow. Old owner key files are not deleted automatically; archive or remove them securely after accepting the upgrade.

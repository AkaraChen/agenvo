# Migrating from Siyin

[简体中文](migration.zh-CN.md)

Agenvo is the new name of the Siyin MCP relay. This repository continues the relay's history. The unrelated earlier Agenvo project is preserved in [agenvo-legacy](https://github.com/Xuanwo/agenvo-legacy); its binaries and configuration are not compatible with this relay. Build this checkout and inspect `node dist/cli.js --help` before replacing any existing `agenvo` command.

## New installations

Use `agenvo`, `AGENVO_CONFIG_DIR` (default `~/.config/agenvo`), and the Agenvo deployment guides. The default Cloudflare manifest is `agenvo-deploy.local.json`; the VPS Compose domain variable is `AGENVO_DOMAIN`. Connector user services use the `io.agenvo.connector.` prefix.

## Existing installations

Renaming a repository does not upgrade a deployed relay or restart a Connector. Keep your existing deployment running until you choose an upgrade window. Building the new checkout does not modify installed services.

Keep the same origin, owner keys, device configuration, runtime paths, state directory, and Cloudflare resource IDs. The three MCP tools and protocol version 1 are unchanged. Wire headers, heartbeat messages, owner JWT domains, `siyin.describe`, serialized fault names, the `SiyinRelay` Durable Object class, and the VPS `siyin.sqlite` filename retain their existing identities. These strings are compatibility identifiers, not unfinished branding changes.

### Owner and Connector configuration

Explicitly select the existing configuration directory:

```sh
export AGENVO_CONFIG_DIR="$HOME/.config/siyin"
node /absolute/path/to/agenvo/dist/cli.js status --json
```

Configuration selection is `AGENVO_CONFIG_DIR`, then the legacy `SIYIN_CONFIG_DIR`, then `~/.config/agenvo`. Agenvo does not automatically discover or copy `~/.config/siyin`. Do not change the configured Codex homes or Herdr roots merely to rename the project.

For a service upgrade, finish active managed Codex turns first. Use the old CLI and the old configuration directory to run `service uninstall`; this stops the old `io.siyin.connector.*` service. Then use the new CLI with `AGENVO_CONFIG_DIR` pointing to that same directory to run `service install`. A manually started Connector must also be stopped before replacement. Never run both services against the same configuration. Herdr itself remains independently running; stopping a managed Codex Connector stops its managed processes. If the old CLI is unavailable, stop and remove its exact launchd/systemd unit before installing the new service.

### Cloudflare

Use the existing manifest and the exact deployed Worker name and origin. For example, if the Worker is named `siyin`:

```sh
AGENVO_CONFIG_DIR="$HOME/.config/siyin" \
  node /absolute/path/to/agenvo/dist/cli.js deploy \
  --config /absolute/path/to/siyin-deploy.local.json \
  --name siyin --origin https://YOUR_EXISTING_RELAY
```

Do not replace the manifest with the new template, rename the Worker, or edit its Durable Object migration history as part of this upgrade. Existing OAuth registrations and MCP URLs depend on the origin. Relay and Connector upgrades can happen separately because their wire identities remain unchanged.

### Single VPS

Stop the old Relay and back up the full state directory before switching the executable. Reuse the existing Relay JSON configuration, origin, owner key, data directory, and `siyin.sqlite` file, including its WAL/SHM files. Only one process may own the database. When replacing a Compose checkout, preserve the Compose project name and volume mappings so it mounts the original data and Caddy volumes; set `AGENVO_DOMAIN` to the existing domain. For systemd, update the installed unit's executable path without changing its user or state permissions. The new `agenvo.service` template is intended for new installations, not a replacement for an existing deployment's paths.

After upgrading, check `/health`, inspect `agenvo admin state --origin https://YOUR_EXISTING_RELAY`, and verify `instances_list` from the existing MCP client. The health response now identifies the service as `agenvo`. Check native state before retrying any write whose result became uncertain during the upgrade.

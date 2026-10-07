# Upgrade older installations

[简体中文](migration.zh-CN.md) · [README](../README.md)

Use this guide for the former combined Agenvo Connector, Siyin installations, or the former owner-key authentication flow. New installations can follow the deployment guides directly.

## Connector

The combined `agenvo` executable is replaced by `agenvo-herdr` and `agenvo-codex-app-server`; use `agenvo-server` for the Relay. Build the new version and retain the old executable and a configuration backup. New default directories are `~/.config/agenvo/herdr` and `~/.config/agenvo/codex-app-server`; neither scans old installations. `SIYIN_CONFIG_DIR` is no longer an implicit fallback.

**An installation with one backend:** run `service uninstall` with the old executable and configuration, then explicitly select that directory with the matching new executable. Configuration, pairing identity and instance fingerprints can be retained. For example, Herdr:

```sh
export AGENVO_CONFIG_DIR="$HOME/.config/agenvo"
node /absolute/path/to/agenvo/apps/herdr/dist/cli.js status --json
node /absolute/path/to/agenvo/apps/herdr/dist/cli.js service install
```

**An installation with both backends:** stop the old Connector, retain only one backend's entries in `config.json` under `instances`, and use its new executable with the old directory to retain that identity. Configure the other backend in its new default directory and pair it separately. Preserve native Herdr roots and Codex homes. Do not copy `deviceId`, `credentials.json`, or pending pairing state to the second Connector. After verifying the new connection, revoke unused instance approvals on the old identity in the admin page.

Stopping a Connector stops its managed Codex processes; finish active turns first. Independent Herdr and attached Codex servers continue running. Service names are derived from configuration directories; uninstall the old service before reusing its directory. If the old CLI is unavailable, remove its exact launchd/systemd unit. Never share a configuration directory or pairing identity between processes.

Codex now always uses full access. Old `policy` fields are discarded; `--sandbox` and `--approval-policy` are unsupported. Approve changed instance fingerprints in `/admin`, then re-read `instance_describe`. Connectors without `managementVersion` support native methods only. Unreleased `agents.*` and `runs.*` methods have been replaced by `management.threads.*`. Herdr new launches support Codex, Claude and Devin; other existing Agent kinds remain discoverable.

## Relay

Keep the origin and persistent state to retain device credentials and OAuth grants. Administrator authentication now uses a shared secret; old owner signing keys are no longer accepted.

- **Cloudflare:** preserve the Worker name, KV ID, DO binding and migration history. Point the manifest's `main` to the new checkout's `apps/cloudflare/src/worker.ts`. Remove `OWNER_PUBLIC_KEY`, `OWNER_EMAIL`, `ACCESS_ISSUER` and `ACCESS_AUD`; set `secrets.required` to `["ADMIN_SECRET"]`. Set that secret with Wrangler and deploy using the existing manifest. Remove any old Access login interception and verify `/admin`.
- **VPS:** stop the Relay and back up the entire data directory. Keep the origin, data path, Compose project/volumes and service user. Remove `ownerPublicKey` from Relay JSON, supply `AGENVO_ADMIN_SECRET` through the [deployment environment](deployment-vps.md), and restart using `agenvo-server serve --config CONFIG`.

Do not rename the `SiyinRelay` DO class or `siyin.sqlite` database; they remain storage compatibility identifiers. There is no automatic Cloudflare/VPS state migration.

Use Wrangler/Compose/systemd for deployment and the MCP client's browser OAuth flow for login. The old `agenvo deploy` and `agenvo client` commands are no longer available. Retire old owner key files after verifying `/health`, administrator login and `instances_list` from your MCP client.

For a domain change, update Connector URLs and client configuration, then [reconnect ChatGPT](chatgpt.md). Verify the new connection before deleting the old deployment. Inspect native state before repeating any write interrupted by the upgrade.

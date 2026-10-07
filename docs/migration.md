# Upgrade older installations

[简体中文](migration.zh-CN.md) · [README](../README.md)

Use this guide for installations created under the Siyin name or the former owner-key authentication flow. New installations can follow the deployment guides directly.

## Connector

Select the old configuration explicitly; Agenvo does not move it automatically:

```sh
export AGENVO_CONFIG_DIR="$HOME/.config/siyin"
node /absolute/path/to/agenvo/dist/cli.js status --json
```

Configuration selection is `AGENVO_CONFIG_DIR`, then `SIYIN_CONFIG_DIR`, then `~/.config/agenvo`. Keep the configured Herdr roots and Codex homes.

Finish managed Codex turns before replacing the Connector: stopping it stops its managed processes, but leaves independent Herdr and attached Codex servers running. Use the old CLI with the old configuration to run `service uninstall`, then the new CLI with the same configuration to run `service install`. If the old CLI is unavailable, remove its exact `io.siyin.connector.*` launchd/systemd unit first. Never run two Connectors against one configuration.

Codex now always uses full access. Old `policy` fields are discarded; `--sandbox` and `--approval-policy` are unsupported. Approve changed instance fingerprints in `/admin`, then re-read `instance_describe`. Connectors without `managementVersion` support native methods only. Unreleased `agents.*` and `runs.*` methods have been replaced by `management.threads.*`. Herdr new launches support Codex, Claude and Devin; other existing Agent kinds remain discoverable.

## Relay

Keep the origin and persistent state to retain device credentials and OAuth grants. Administrator authentication now uses a shared secret; old owner signing keys are no longer accepted.

- **Cloudflare:** preserve the Worker name, KV ID, DO binding and migration history. Point the manifest's `main` to the new checkout's `src/relay/worker.ts`. Remove `OWNER_PUBLIC_KEY`, `OWNER_EMAIL`, `ACCESS_ISSUER` and `ACCESS_AUD`; set `secrets.required` to `["ADMIN_SECRET"]`. Set that secret with Wrangler and deploy using the existing manifest. Remove any old Access login interception and verify `/admin`.
- **VPS:** stop the Relay and back up the entire data directory. Keep the origin, data path, Compose project/volumes and service user. Remove `ownerPublicKey` from Relay JSON, supply `AGENVO_ADMIN_SECRET` through the [deployment environment](deployment-vps.md), and restart using the new executable.

Do not rename the `SiyinRelay` DO class or `siyin.sqlite` database; they remain storage compatibility identifiers. There is no automatic Cloudflare/VPS state migration.

Use Wrangler/Compose/systemd for deployment and the MCP client's browser OAuth flow for login. The old `agenvo deploy` and `agenvo client` commands are no longer available. Retire old owner key files after verifying `/health`, administrator login and `instances_list` from your MCP client.

For a domain change, update Connector URLs and client configuration, then [reconnect ChatGPT](chatgpt.md). Verify the new connection before deleting the old deployment. Inspect native state before repeating any write interrupted by the upgrade.

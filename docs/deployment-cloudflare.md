# Cloudflare deployment

[简体中文](deployment-cloudflare.zh-CN.md) · [README](../README.md)

Prerequisites: a Cloudflare account with Workers, SQLite Durable Objects and KV available, Node.js 24.13+, and the built CLI. Review your Cloudflare plan's current quotas and billing. No container is required.

Cloudflare authentication must already be available through Wrangler or `CLOUDFLARE_API_TOKEN`. Interactive account login is a one-time platform prerequisite, not a deployment step.

```sh
# Only if this machine has never authenticated to Cloudflare:
npx wrangler login
agenvo deploy --name agenvo --origin https://agenvo.YOUR_SUBDOMAIN.workers.dev
curl --fail https://agenvo.YOUR_SUBDOMAIN.workers.dev/health
```

Wrangler provisions the configured resources. The CLI saves resource identities in `agenvo-deploy.local.json` and generates the owner key in `AGENVO_CONFIG_DIR`. Preserve both for upgrades. Run the same command with the same configuration and origin to update. A name or origin change is a separate deployment decision, not an ordinary upgrade.

Signed CLI administration works without Cloudflare Access: follow the [usage guide](usage.md) for pairing, OAuth approval and revocation. Keep public MCP, OAuth, pairing and Connector endpoints outside an Access login wall.

## Optional browser administration

For the browser UI, create a self-hosted Cloudflare Access application protecting exactly your relay's `/admin` and `/authorize` paths. Allow only the owner's identity. Set its issuer, audience and owner email:

```sh
agenvo deploy --name agenvo --origin https://agenvo.YOUR_SUBDOMAIN.workers.dev \
  --owner owner@example.com \
  --issuer https://YOUR_TEAM.cloudflareaccess.com --aud YOUR_ACCESS_AUDIENCE
```

The Worker verifies Access signatures, issuer, audience, expiry and exact owner identity; it does not trust an email header alone. Access settings do not authorize MCP clients until explicit consent. Without configured Access, use `agenvo client inspect/approve` on the authorization URL instead of browser approval.

## State and recovery

The Durable Object stores device approvals, grants and routing state in SQLite. OAuth provider records live in KV. Connector WebSockets use hibernation; there is no persistent per-client MCP SSE stream. A pending native call keeps a finite request open for at most ten seconds.

Do not rename or delete the Durable Object binding, migration history or OAuth KV namespace during an update. Preserve the deployment manifest and owner key in secure backups. Cloudflare storage recovery is platform-specific; there is no portable full-state export or automatic migration to VPS yet. Deleting the deployment requires fresh device pairing and client authorization. Revocation blocks future access, but does not cancel already-started native tasks.

`npm run test:integration` exercises the Worker inside local workerd with real Durable Object/KV bindings. This is not a claim of live Cloudflare deployment verification on your account. Production setup should also check `/health`, pair one device and complete one harmless MCP read through your own client.


## Unattended deployment and verification

With existing Cloudflare credentials, deployment and Agenvo authorization require no browser or management-page actions:

```sh
agenvo deploy --name agenvo --origin https://agenvo.YOUR_SUBDOMAIN.workers.dev
agenvo instance add herdr --id herdr --config-root "$HOME/.config/herdr" --cwd "$HOME/Code"
agenvo connect https://agenvo.YOUR_SUBDOMAIN.workers.dev --name laptop --approve
agenvo service install
agenvo client login --origin https://agenvo.YOUR_SUBDOMAIN.workers.dev   --name deployment-check --output "$HOME/.config/agenvo/client.json"
agenvo client call instances_list --credentials "$HOME/.config/agenvo/client.json"
```

`connect --approve` uses the owner's existing signing key and the fingerprint returned directly to the connecting device. It does not grant a runner the ability to authorize itself without that key. For a remote runner, use `connect --no-wait --no-browser --json`, pass its code and fingerprint through your authenticated SSH orchestration to `pairing approve` on the owner machine, then run `connect --no-browser` again on the runner and install its service. The owner key stays on the owner machine. Both pairing commands can be automated; no page or manual fingerprint transcription is necessary.

`client login` creates an OAuth client, signs consent with the owner key, validates the callback state and exchanges the PKCE code locally. It writes access/refresh tokens only to a new mode-0600 file and refuses to overwrite an existing file. `client call` refreshes expiring access tokens and supports `--params-file` for MCP arguments. Protect the file as a credential; never commit it. An expired/revoked grant requires another owner-authorized login. These commands verify the same OAuth/MCP routes used by external clients.

Third-party clients retain their own connection configuration and OAuth identity. A CLI-created client does not automatically reconfigure ChatGPT or another hosted assistant. Automating that final client change requires that product's supported configuration API; do not substitute the deployment-check identity or claim the client's migration is verified from CLI checks alone.

# Cloudflare deployment

[简体中文](deployment-cloudflare.zh-CN.md) · [README](../README.md)

Prerequisites: a Cloudflare account with Workers, SQLite Durable Objects and KV available, Node.js 24.13+, and the built CLI. Review your Cloudflare plan's current quotas and billing. No container is required.

```sh
npx wrangler login
siyin deploy --name siyin --origin https://siyin.YOUR_SUBDOMAIN.workers.dev
curl --fail https://siyin.YOUR_SUBDOMAIN.workers.dev/health
```

Wrangler provisions the configured resources. The CLI saves resource identities in `siyin-deploy.local.json` and generates the owner key in `SIYIN_CONFIG_DIR`. Preserve both for upgrades. Run the same command with the same configuration and origin to update. A name or origin change is a separate deployment decision, not an ordinary upgrade.

Signed CLI administration works without Cloudflare Access: follow the [usage guide](usage.md) for pairing, OAuth approval and revocation. Keep public MCP, OAuth, pairing and Connector endpoints outside an Access login wall.

## Optional browser administration

For the browser UI, create a self-hosted Cloudflare Access application protecting exactly your relay's `/admin` and `/authorize` paths. Allow only the owner's identity. Set its issuer, audience and owner email:

```sh
siyin deploy --name siyin --origin https://siyin.YOUR_SUBDOMAIN.workers.dev \
  --owner owner@example.com \
  --issuer https://YOUR_TEAM.cloudflareaccess.com --aud YOUR_ACCESS_AUDIENCE
```

The Worker verifies Access signatures, issuer, audience, expiry and exact owner identity; it does not trust an email header alone. Access settings do not authorize MCP clients until explicit consent. Without configured Access, use `siyin client inspect/approve` on the authorization URL instead of browser approval.

## State and recovery

The Durable Object stores device approvals, grants and routing state in SQLite. OAuth provider records live in KV. Connector WebSockets use hibernation; there is no persistent per-client MCP SSE stream. A pending native call keeps a finite request open for at most ten seconds.

Do not rename or delete the Durable Object binding, migration history or OAuth KV namespace during an update. Preserve the deployment manifest and owner key in secure backups. Cloudflare storage recovery is platform-specific; there is no portable full-state export or automatic migration to VPS yet. Deleting the deployment requires fresh device pairing and client authorization. Revocation blocks future access, but does not cancel already-started native tasks.

`npm run test:integration` exercises the Worker inside local workerd with real Durable Object/KV bindings. This is not a claim of live Cloudflare deployment verification on your account. Production setup should also check `/health`, pair one device and complete one harmless MCP read through your own client.

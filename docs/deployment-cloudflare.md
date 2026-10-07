# Cloudflare deployment

[简体中文](deployment-cloudflare.zh-CN.md) · [README](../README.md)

Deploy the Worker, SQLite Durable Object and OAuth KV with Wrangler. No always-on container is required. The Agenvo CLI does not deploy infrastructure. Prepare a Cloudflare account and Node.js 24.13+, then run `npm ci` in the checkout.

## Configure and deploy

```sh
cp wrangler.jsonc wrangler.local.json
npx wrangler login
npx wrangler kv namespace create OAUTH_KV --config wrangler.local.json
```

Edit `wrangler.local.json`: set your Worker `name`, canonical public HTTPS `vars.ORIGIN`, and the returned namespace ID in `kv_namespaces[0].id`. For an existing deployment, preserve its KV ID, DO bindings and migration history instead of creating new resources. This local manifest is ignored by Git.

For your own domain, add `routes: [{ "pattern": "relay.example.com", "custom_domain": true }]` and set `workers_dev: false`. The domain must belong to an active zone in this Cloudflare account; Wrangler configures the route and certificate. Keep `workers_dev: true` for a workers.dev address. ORIGIN must match the public address exactly, without a path or trailing slash.

Generate and save an administrator key in your password manager: at least 32 random bytes encoded as hex or base64url, such as 64 hex characters. Paste that same key into the following secret prompt. Never put it in the manifest or Git:

```sh
npx wrangler secret put ADMIN_SECRET --config wrangler.local.json
npx wrangler deploy --config wrangler.local.json
curl --fail https://relay.example.com/health
```

Open `https://relay.example.com/admin`, sign in with the key, then [pair devices](usage.md) and [connect ChatGPT](chatgpt.md). No email provider, Access application, owner key pair or initial setup link is required. Keep MCP, OAuth, pairing and Connector endpoints outside additional login walls.

CI can invoke Wrangler using a preconfigured Cloudflare API token; inject the administrator key through platform secrets. Explicit administrator automation can use `AGENVO_ADMIN_SECRET`, as described in the usage guide. Initial ChatGPT authorization still uses browser login and consent.

## Upgrade and recover

Run `wrangler deploy` with the same manifest and resource IDs. Ordinary upgrades keep ORIGIN stable; domain migrations require updating clients and checking Connector URLs. Rotating the administrator key invalidates browser sessions, but does not revoke paired devices or OAuth grants. Revoke those independently in the management page when needed.

The DO stores pairing, browser sessions and relay authorization; KV holds OAuth provider state. Back up the manifest and protect secrets. Automatic CF/VPS state migration is not supported. Deleting storage requires fresh pairing and consent. Revocation does not stop native work.

Acceptance requires public `/health`, browser login, device pairing and an actual `instances_list` call from the intended MCP client. Local workerd tests do not establish cloud-account or client acceptance.

# Single VPS deployment

[简体中文](deployment-vps.zh-CN.md) · [README](../README.md)

Use one Linux VPS with a public DNS name, ports 80/443 open, Docker Engine and Compose. Point the DNS name to this server. The Relay runs as one process; do not add replicas or put its SQLite database on a network filesystem. Coding runtimes run on separately paired devices.

## Configure and start

Build the CLI as described in the README. On the owner machine:

```sh
siyin relay init --origin https://relay.example.com \
  --data-dir /data --host 0.0.0.0 --port 8080 --trusted-proxy \
  --output deploy/vps/relay.local.json
```

This creates a public Relay configuration and a private owner key at `<SIYIN_CONFIG_DIR>/owner/<origin-hash>.json` (`SIYIN_CONFIG_DIR` defaults to `~/.config/siyin`). Keep the private key on your owner machine and back it up securely. Only copy `relay.local.json` to the VPS checkout at `deploy/vps/relay.local.json`. Never put it or keys into Git.

On the VPS, from the repository root:

```sh
mkdir -p deploy/vps/data
sudo chown 1000:1000 deploy/vps/data deploy/vps/relay.local.json
sudo chmod 700 deploy/vps/data
sudo chmod 600 deploy/vps/relay.local.json
export SIYIN_DOMAIN=relay.example.com
docker compose -f deploy/vps/compose.yaml up -d --build
curl --fail https://relay.example.com/health
```

UID 1000 is the `node` user in the image. Caddy obtains and renews a public certificate. Only Caddy publishes ports; do not expose port 8080. Caddy must preserve the original Host header. Container logs contain lifecycle messages, not native task output. Keep the domain in `deploy/vps/.env` for future Compose commands, or export it each time.

Continue with [device pairing and MCP authorization](usage.md). VPS administration uses the signed CLI; the browser authorization page explains how to approve its URL. Cloudflare Access is not needed.

## Without Docker

Install Node.js 24.13+ and build the checkout in `/opt/siyin`. Create a dedicated `siyin` OS user, a `/var/lib/siyin` directory owned by it with mode 0700, and a readable `/etc/siyin/relay.json`. Generate the configuration with `--data-dir /var/lib/siyin --host 127.0.0.1 --trusted-proxy`; copy only this configuration to the server. Adapt and install [siyin.service](../deploy/vps/siyin.service), then start it with systemd. The Node binary path must match your installation. Configure Caddy or another HTTPS proxy to forward to `127.0.0.1:8080` and preserve Host and WebSocket upgrade headers.

`relay serve` also accepts a configuration `tls` object with absolute `cert` and `key` file paths for direct TLS. Certificate renewal and restarting after rotation are the operator's responsibility. HTTP is an internal proxy transport only; public URLs and Connector connections must use HTTPS/WSS.

## Upgrade, back up and recover

Stop the Relay before making a filesystem backup; copy the entire data directory, the public configuration and proxy configuration. Keep a separate encrypted backup of the owner private key. Do not copy only `siyin.sqlite` while the process is running: its WAL may contain newer transactions.

For an upgrade, take a stopped backup, rebuild the image, and restart the same Compose project with the same data directory. The database retains paired devices and OAuth grants. Active requests interrupted by restart have uncertain outcomes: inspect native state before repeating a write. Connectors reconnect automatically; Herdr remains independent. Restore the previous image and matching backup if an upgrade fails. Database schema versions are checked at startup; there is no cross-platform state migration tool in this release.

SQLite's exclusive lock prevents a second Relay from using the same database. Scaling to multiple processes, shared network disks, and automatic failover are unsupported. Dynamic OAuth client registration is bounded; this deployment is intended for personal use, not anonymous multi-tenant hosting.

## Proxy and OAuth limits

`--trusted-proxy` trusts exactly one reverse proxy hop and uses its forwarded client address for rate limiting. Enable it only when the Relay is reachable exclusively through that proxy, which must overwrite untrusted forwarded headers. Caddy's default proxy configuration provides this boundary. Direct TLS deployments should leave it disabled; supplied forwarded headers are then ignored. Public pairing is limited to ten attempts per client address per ten minutes. Without trusted proxy configuration, clients behind one proxy share that limit.

VPS OAuth redirect URIs must use HTTPS or loopback HTTP; custom application schemes are unsupported. Unapproved registrations expire after one hour; restart the client's registration flow if it waited longer. Expired confidential-client secrets are removed automatically. Owner-approved public clients retain their registration. Registration is limited to 256 entries and the SDK's per-client-address rate limit. A valid owner signature tolerates five seconds of clock skew while retaining a maximum declared lifetime of 60 seconds.

Data directories created by unpublished development revisions are not a supported upgrade source; recreate those test deployments and pair again. The initial released VPS format starts with this implementation.

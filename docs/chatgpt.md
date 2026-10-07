# Add Agenvo to ChatGPT

[中文](chatgpt.zh-CN.md) · [README](../README.md)

This guide separates observed ChatGPT steps from pending authorization checks. On October 7, 2026, the form was accessible, but creation returned `Custom apps aren't allowed in this context. Check your workspace permissions or security settings`. The ChatGPT connection was therefore not completed. Successful OAuth/MCP checks through the Agenvo CLI do not establish that ChatGPT is connected.

## Prerequisites

Complete [relay deployment](deployment-cloudflare.md) and [Connector pairing](usage.md). Prepare the public HTTPS MCP URL `https://YOUR_RELAY/mcp` and keep the signing key for that origin on the owner machine. Cloudflare Access must not intercept `/mcp` or OAuth endpoints with a login page.

The ChatGPT account or workspace must permit custom MCP servers. UI labels vary by account and product version; the following labels were observed during this attempt and do not establish support for every subscription.

The current [official connection guide](https://developers.openai.com/plugins/deploy/connect-chatgpt) starts with Plugins → Add custom MCP server and does not list enabling Developer mode as a prerequisite. Search snippets may retain older Developer mode instructions; open the current page before relying on them. The [custom MCP guide](https://developers.openai.com/api/docs/guides/custom-mcp-server) explicitly says workspace permissions and security restrictions, including Lockdown, still apply.

## Observed browser steps

1. Sign in to ChatGPT and open **Plugins** in the sidebar.
2. Choose **Add → Add custom MCP server**.
3. Fill in the fields below. The icon is optional.
4. Read the notice, verify that the relay is yours, and select **I understand and want to continue**.
5. Choose **Create as a plugin**.

| Field | Value |
| --- | --- |
| Name | `Agenvo` |
| Description (optional) | `Manage threads in approved Herdr and Codex instances through your self-hosted Agenvo relay.` |
| Connection | `Server URL` |
| Server URL | `https://YOUR_RELAY/mcp` |
| Authentication | `OAuth` |

Advanced OAuth settings were left unchanged. Do not choose No authentication. Agenvo supports OAuth metadata discovery, dynamic client registration, and S256 PKCE. Do not enter the deployment-check client's token into ChatGPT.

## If creation is rejected

For `Custom apps aren't allowed in this context`, check the current account/workspace and open **Settings → Plugins**. If the page says **Couldn't load plugin settings**, use its **Try again** control once.

During this attempt, settings loaded after retry, but creation was still rejected. The account menu showed personal Pro, and the existing Siyin connection remained connected. The visible settings offered no switch to remove the restriction. This evidence does not distinguish an account policy from a platform fault or establish that a different subscription is needed. Creation must become available on the ChatGPT side before continuing. Approving the relay again, disabling OAuth, or deleting the old connection does not resolve this stage.

A subsequent check of **Settings → Security and login** showed Lockdown mode off and no Developer mode switch. Searching settings for `developer` returned No results found. Enforce CSP for custom apps was also off; its description concerns custom-app network restrictions, not creation permission. Enabling it is not an MCP setup prerequisite. No security settings were changed.

For an enterprise workspace, also review Workspace apps and Permissions & roles using the [official plugin controls guide](https://learn.chatgpt.com/docs/enterprise/apps-and-connectors). Do not assume these enterprise administration controls exist for a personal account. The observed Lockdown setting is ruled out, but the backend reason for rejecting creation remains unknown.

## Authorization after creation is permitted

The following is Agenvo's supported client authorization flow; **it was not reached in this ChatGPT attempt**. If ChatGPT opens the relay's `/authorize?...` page, inspect that complete URL on the owner machine:

```sh
agenvo client inspect 'AUTHORIZATION_URL' --origin https://YOUR_RELAY
agenvo client approve 'AUTHORIZATION_URL' --origin https://YOUR_RELAY \
  --client-id CLIENT_ID --redirect-uri 'EXACT_REDIRECT_URI' \
  --output /private/path/chatgpt-consent.json
```

Verify the client identity and exact redirect URI returned by inspect; do not guess or hard-code ChatGPT's callback URL. After approval, open `redirectTo` from the output file in the browser that initiated the flow. This one-time callback contains an authorization code: keep it out of documentation, chats, screenshots, and Git. The owner key stays local. The output file is created with mode 0600 and must not already exist.

`agenvo client login` creates a separate CLI client and cannot complete ChatGPT's OAuth flow.

## Acceptance and retirement of the old deployment

Check both ChatGPT's connection status and actual tool calls. Ask the intended assistant to call Agenvo's `instances_list` and verify the expected devices. Use `instance_describe` to discover management capabilities, then `runtime_call` with `management.services.list` and `management.threads.list`. If a Thread is active, pass its returned `threadRef` to `management.threads.observe`. An empty list is valid; starting a paid model task is not required for this check.

Client migration is complete only after the intended assistant successfully calls the new endpoint. Keep the old endpoint until then. Afterwards, revoke old client grants, stop old Connectors, and remove the old relay's dedicated resources. Preserve native Herdr/Codex sessions. Renaming the old plugin does not migrate its endpoint.

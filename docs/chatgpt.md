# Connect Agenvo in ChatGPT

[简体中文](chatgpt.zh-CN.md) · [README](../README.md)

Deploy the relay, configure its administrator key and pair a device. Prepare your public HTTPS MCP URL, such as `https://relay.example.com/mcp`. Your ChatGPT account or workspace must allow custom MCP servers; UI availability depends on the current account.

1. Open **Plugins → Add → Add custom MCP server** in ChatGPT.
2. Enter `Agenvo`, your Server URL, and **OAuth** authentication.
3. Confirm that this is your relay, create the plugin and choose **Continue to Agenvo**.
4. Enter your administrator key on the Agenvo login page. An existing login session skips this step.
5. Inspect the client and callback, then choose **Allow**. The browser returns to ChatGPT automatically.
6. Ask the intended assistant to call `instances_list`, verify your devices, then use `instance_describe` and `management.services.list`.

Do not manually configure client credentials, create callback files or copy tokens. ChatGPT and Agenvo handle dynamic registration, PKCE, code exchange and refresh. Enter the administrator key only on Agenvo's login page; never give it to ChatGPT. Consent covers all approved instances, including future approvals.

Workspace or security errors before leaving ChatGPT belong to its account/plugin configuration; they do not establish an Agenvo callback bug. Once redirected to Agenvo, inspect the actual login or consent error. Do not disable authentication to work around connection issues.

This guide describes the implemented flow. Acceptance for a specific account requires a successful connection and real tool calls. Retire an old deployment only after those checks succeed.

References: [official connection guide](https://developers.openai.com/plugins/deploy/connect-chatgpt) · [official OAuth flow](https://developers.openai.com/plugins/build/auth).

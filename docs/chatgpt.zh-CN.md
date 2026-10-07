# 在 ChatGPT 中添加 Agenvo

[English](chatgpt.md) · [README](../README.zh-CN.md)

2026-10-07 实测已创建并安装 Agenvo 插件，进入 Connect Agenvo 授权弹窗；OAuth 连接和实际工具调用尚未完成。早先创建被拒绝，用户删除旧 Siyin MCP 和插件后再次创建成功，但不能据此断言平台存在数量限制。Agenvo CLI 的 OAuth/MCP 验收不能代替 ChatGPT 端验收。

## 前提

先完成 [Relay 部署](deployment-cloudflare.zh-CN.md)和 [Connector 配对](usage.zh-CN.md)。准备公网 HTTPS MCP 地址 `https://YOUR_RELAY/mcp`，并在所有者机器保留对应 origin 的签名密钥。客户端访问 `/mcp` 与 OAuth 端点时不应遇到 Cloudflare Access 登录页。

ChatGPT 账户或工作区必须允许添加自定义 MCP。界面会随账户和产品版本变化；以下按钮名称来自本次实测界面，不能据此承诺所有套餐均支持。

当前[官方接入文档](https://developers.openai.com/plugins/deploy/connect-chatgpt)直接从 Plugins → Add custom MCP server 开始，没有列出开启 Developer mode 的前置步骤。搜索摘要可能仍保留旧版 Developer mode 说明，排查时应打开正文核对。[自定义 MCP 文档](https://developers.openai.com/api/docs/guides/custom-mcp-server)明确说明工作区权限和包括 Lockdown 在内的安全限制仍适用。

## 已验证的网页操作

1. 登录 ChatGPT，在左侧打开 **Plugins**。
2. 点击右上角 **Add → Add custom MCP server**。
3. 填写下表，图标可以留空。
4. 阅读风险提示，确认连接的是自己的 Relay 后，勾选 **I understand and want to continue**。
5. 点击 **Create as a plugin**。

| 字段 | 值 |
| --- | --- |
| Name | `Agenvo` |
| Description (optional) | `Manage threads in approved Herdr and Codex instances through your self-hosted Agenvo relay.` |
| Connection | `Server URL` |
| Server URL | `https://YOUR_RELAY/mcp` |
| Authentication | `OAuth` |

本次没有填写 Advanced OAuth settings，也没有选择 No authentication。Agenvo 提供 OAuth 元数据发现、动态客户端注册与 S256 PKCE；不要将部署验收客户端的 token 填进 ChatGPT。

## 创建被拒绝时

如果出现上述 `Custom apps aren't allowed in this context`，先确认当前账户/工作区，再打开 **Settings → Plugins** 检查配置是否正常加载。若出现 **Couldn't load plugin settings**，可使用页面的 **Try again** 重试一次。

本次设置重试后正常加载，但再次创建仍被拒绝。账户菜单显示个人 Pro；现有嗣音连接显示已连接。可见设置没有提供解除该限制的开关。这些事实不能确定是账户策略还是平台故障，也不能证明需要更换套餐。此时尚未到达 Agenvo 授权页面，应由 ChatGPT 侧恢复自定义 MCP 创建能力后继续；重复批准 Relay、关闭 OAuth 或删除旧连接都不能作为修复。

进一步检查 **Settings → Security and login**：本次 Lockdown mode 为关闭，页面没有 Developer mode 开关，设置搜索 `developer` 返回 No results found。App security 中的 Enforce CSP for custom apps 也为关闭；其说明是限制自定义应用的网络访问，不是创建权限开关，不应将开启它当作添加 MCP 的前提。本次没有更改安全设置。

企业工作区还需按[官方插件权限说明](https://learn.chatgpt.com/docs/enterprise/apps-and-connectors)核对 Workspace apps 与 Permissions & roles；不要把企业管理入口默认套用到个人账户。当前证据排除了可见的 Lockdown 开关，但未确定后台拒绝创建的具体原因。

## 创建获准后的授权步骤

创建成功后，ChatGPT 显示 **Connect Agenvo**，点击 **Continue to Agenvo** 发起连接。本次该按钮恢复可点击状态，但没有打开授权页。浏览器诊断显示 ChatGPT 自身的 `mfa_requirement` 请求收到 HTTP 403，响应为 Cloudflare managed challenge HTML。这个请求发生在跳转到 Agenvo 之前，不能把它当成 Agenvo OAuth 拒绝，也不能据此认定用户尚未开启 MFA。应在原浏览器完成 ChatGPT 要求的安全验证后，从已创建插件继续连接，不要重新创建插件或关闭 MFA。

以下是 Agenvo 已支持的客户端授权流程，**尚未在本次 ChatGPT 流程中走通**。如果 ChatGPT 打开 Relay 的 `/authorize?...` 页面，将该完整地址交给所有者 CLI 检查：

```sh
agenvo client inspect 'AUTHORIZATION_URL' --origin https://YOUR_RELAY
agenvo client approve 'AUTHORIZATION_URL' --origin https://YOUR_RELAY \
  --client-id CLIENT_ID --redirect-uri 'EXACT_REDIRECT_URI' \
  --output /private/path/chatgpt-consent.json
```

使用 inspect 返回的客户端身份和准确回调地址，不猜测或硬编码 ChatGPT 回调 URL。核对后批准，使用发起登录的同一浏览器打开输出文件中的 `redirectTo`。这个一次性回调包含授权码，不放进文档、聊天、截图或 Git；所有者私钥留在本机。输出文件权限为 0600，路径必须尚不存在。

`agenvo client login` 创建的是独立 CLI 客户端，不能替代这个由 ChatGPT 发起的 OAuth 流程。

## 验收与旧部署清理

必须同时检查 ChatGPT 的连接状态与实际工具调用。让目标助手使用 Agenvo 调用 `instances_list`，核对预期设备；再通过 `instance_describe` 确认共同管理能力，用 `runtime_call` 调用 `management.services.list`、`management.threads.list`。有活跃 Thread 时，用其返回的 `threadRef` 调用 `management.threads.observe`。空列表是有效结果，不需要为验证而启动付费模型任务。

只有目标助手实际调用新入口成功，才完成客户端迁移。迁移期间保留旧入口；之后撤销旧客户端授权、停用旧 Connector，并清理旧 Relay 的专用资源。不要删除 Herdr/Codex 原生会话或把旧插件的显示名称变化当作入口已迁移。

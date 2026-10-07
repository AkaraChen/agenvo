# 在 ChatGPT 中连接 Agenvo

[English](chatgpt.md) · [README](../README.zh-CN.md)

先部署 Relay、设置管理员密钥并配对设备。准备公网 HTTPS 地址 `https://relay.example.com/mcp`。ChatGPT 账户或工作区必须允许自定义 MCP；界面与权限以当前账户为准。

1. 在 ChatGPT 打开 **Plugins → Add → Add custom MCP server**。
2. 名称填写 `Agenvo`，Server URL 填写自己的 MCP 地址，Authentication 选择 **OAuth**。
3. 确认连接自己的 Relay 后创建插件，选择 **Continue to Agenvo**。
4. 在 Agenvo 登录页输入管理员登录密钥。已经登录时跳过此步。
5. 核对客户端与回调地址，点击 **Allow / 允许访问**，浏览器自动返回 ChatGPT。
6. 在目标助手中调用 `instances_list`，确认看得到自己的设备；再调用 `instance_describe` 和 `management.services.list`。

不需要手工配置 client ID、client secret、回调文件或复制 token。动态客户端注册、PKCE、授权码交换和刷新由 ChatGPT 与 Agenvo 完成。管理员登录密钥只输入 Agenvo 的登录页，不交给 ChatGPT。授权覆盖所有已批准实例，包括之后批准的实例。

如果 ChatGPT 在跳转前报工作区权限或安全策略错误，检查 ChatGPT 的账户与插件设置；该错误不能证明 Agenvo 回调配置错误。若已到达 Agenvo，则根据页面的登录或授权错误排查。不要通过关闭认证解决接入问题。

当前指南描述实现流程；对具体账户的验收必须包括连接成功与真实工具调用。迁移旧入口时，完成这些步骤后才撤销旧授权并删除旧部署。

参考：[官方连接说明](https://developers.openai.com/plugins/deploy/connect-chatgpt) · [官方 OAuth 流程](https://developers.openai.com/plugins/build/auth)。

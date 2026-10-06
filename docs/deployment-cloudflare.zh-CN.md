# Cloudflare 部署

[English](deployment-cloudflare.md) · [README](../README.zh-CN.md)

准备可使用 Workers、SQLite Durable Objects 和 KV 的 Cloudflare 账号、Node.js 24.13+ 与已构建的 CLI。部署前核对自己的 Cloudflare 套餐配额与计费，无需容器。

```sh
npx wrangler login
agenvo deploy --name agenvo --origin https://agenvo.YOUR_SUBDOMAIN.workers.dev
curl --fail https://agenvo.YOUR_SUBDOMAIN.workers.dev/health
```

Wrangler 创建配置中的资源。CLI 将资源标识保存到 `agenvo-deploy.local.json`，在 `AGENVO_CONFIG_DIR` 中生成所有者私钥。升级时保留两者，使用相同配置和 origin 再次部署。修改名称或 origin 属于独立的部署变更，不是普通升级。

签名 CLI 不依赖 Cloudflare Access，按[使用指南](usage.zh-CN.md)完成配对、OAuth 批准和撤销。MCP、OAuth、配对和 Connector 公共端点不能被 Access 登录页拦截。

## 可选网页管理

需要网页管理时，创建自托管 Cloudflare Access 应用，精确保护 Relay 的 `/admin` 和 `/authorize` 路径，只允许所有者身份。配置 issuer、audience 和邮箱：

```sh
agenvo deploy --name agenvo --origin https://agenvo.YOUR_SUBDOMAIN.workers.dev \
  --owner owner@example.com \
  --issuer https://YOUR_TEAM.cloudflareaccess.com --aud YOUR_ACCESS_AUDIENCE
```

Worker 验证 Access 签名、issuer、audience、有效期和准确身份，不单独信任邮箱请求头。配置 Access 不代表 MCP 客户端已被授权，仍需明确同意。未配置 Access 时，通过 `agenvo client inspect/approve` 批准授权页面地址。

## 状态与恢复

Durable Object 的 SQLite 保存设备批准、授权与路由状态；OAuth Provider 记录保存在 KV。Connector WebSocket 可休眠，不为每个 MCP 客户端保持 SSE 流。原生调用最多保持十秒的有限请求。

升级时不要重命名或删除 Durable Object 绑定、迁移历史和 OAuth KV 命名空间。安全备份部署配置与所有者私钥。云端状态恢复依赖 Cloudflare 自身能力，首版没有可移植的完整导出或迁移到 VPS 的工具。删除部署后需要重新配对设备并授权客户端。撤销会阻止后续访问，但不会取消已经开始的原生任务。

`npm run test:integration` 在本地 workerd 中验证真实 Durable Object/KV 绑定，不代表已在你的 Cloudflare 账号上验证公网部署。生产配置后还应检查 `/health`、配对一台设备，并从自己的 MCP 客户端完成一次无副作用读取。

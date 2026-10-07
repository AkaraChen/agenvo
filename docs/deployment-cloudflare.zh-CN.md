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


## 无人值守部署与验收

机器已具备 Wrangler 登录状态或 `CLOUDFLARE_API_TOKEN` 时，部署和 Agenvo 授权均不需要浏览器或管理页。Cloudflare 账号的首次授权属于平台前提，不是每次部署的步骤。

```sh
agenvo deploy --name agenvo --origin https://agenvo.YOUR_SUBDOMAIN.workers.dev
agenvo instance add herdr --id herdr --config-root "$HOME/.config/herdr" --cwd "$HOME/Code"
agenvo connect https://agenvo.YOUR_SUBDOMAIN.workers.dev --name laptop --approve
agenvo service install
agenvo client login --origin https://agenvo.YOUR_SUBDOMAIN.workers.dev \
  --name deployment-check --output "$HOME/.config/agenvo/client.json"
agenvo client call instances_list --credentials "$HOME/.config/agenvo/client.json"
```

`connect --approve` 使用已有所有者签名密钥，并核对设备直接取得的指纹；没有所有者密钥的 runner 不能自行授权。远程 runner 使用 `connect --no-wait --no-browser --json`，由可信 SSH 调度程序取得 code 和 fingerprint，在所有者机器执行 `pairing approve`，随后在 runner 再次执行 `connect --no-browser` 完成配对并安装服务。全过程可由脚本完成，不要求手工抄写指纹，所有者密钥也不传到 runner。

`client login` 注册 OAuth 客户端、签名批准、验证回调 state，并在本地完成 PKCE code 交换。访问及刷新 token 只写入新建的 0600 文件，禁止覆盖已有文件。`client call` 自动刷新即将过期的 access token，支持 `--params-file` 传入 MCP 参数。凭据文件不能提交到 Git；grant 到期或撤销后需再次以所有者凭据登录。这些命令使用与外部客户端相同的 OAuth/MCP 路由。

第三方客户端仍有自己的连接配置和 OAuth 身份。CLI 创建的客户端不会自动修改 ChatGPT 或其他托管助手；最后这一步能否自动化取决于对方是否提供配置 API。不能用部署验收客户端的结果冒充第三方客户端已经迁移。

# Cloudflare 部署

[English](deployment-cloudflare.md) · [README](../README.zh-CN.md)

使用 Wrangler 部署 Worker、SQLite Durable Object 和 OAuth KV，无需常驻容器。Agenvo CLI 不负责部署。准备 Cloudflare 账号、Node.js 24.13+，在仓库运行 `npm ci`。

## 配置与部署

```sh
cp wrangler.jsonc wrangler.local.json
npx wrangler login
npx wrangler kv namespace create OAUTH_KV --config wrangler.local.json
```

编辑 `wrangler.local.json`：设置自己的 Worker `name`、公开 HTTPS `vars.ORIGIN`，把创建命令返回的 KV ID 填入 `kv_namespaces[0].id`。使用已有部署时保留原来的 KV ID、DO 绑定和迁移历史，不重新创建资源。此文件已被 Git 忽略。

使用自己的自定义域名时，增加 `routes: [{ "pattern": "relay.example.com", "custom_domain": true }]`，并设置 `workers_dev: false`。域名必须属于该 Cloudflare 账号的有效 zone；Wrangler 配置路由及证书。使用 workers.dev 地址时保留 `workers_dev: true`。ORIGIN 必须与实际访问地址一致，不包含路径或结尾斜杠。

在密码管理器生成并保存至少 32 随机字节编码为 hex 或 base64url 的管理员登录密钥（例如 64 位 hex）。将同一密钥粘贴到下面的 secret 提示中，不把密钥写进配置或 Git：

```sh
npx wrangler secret put ADMIN_SECRET --config wrangler.local.json
npx wrangler deploy --config wrangler.local.json
curl --fail https://relay.example.com/health
```

打开 `https://relay.example.com/admin`，使用该密钥登录，随后[配对设备](usage.zh-CN.md)和[连接 ChatGPT](chatgpt.zh-CN.md)。无需邮箱、Access 应用、所有者公私钥或首次设置链接。不要在 MCP、OAuth、配对或 Connector 端点前放置额外登录墙。

平台已配置 API token 时可在 CI 中调用 Wrangler；管理员密钥仍通过平台 secret 注入。自动化管理可显式提供 `AGENVO_ADMIN_SECRET`，详见使用指南。ChatGPT 的首次连接仍在浏览器登录并批准。

## 升级与恢复

使用原来的 manifest 和资源 ID 重新运行 `wrangler deploy`。普通升级保持 ORIGIN 不变；域名迁移需重新配置客户端并检查 Connector 地址。更改管理员密钥会使网页会话失效，但不会撤销已批准的设备或 OAuth grant。需要阻止这些访问时，在管理页分别撤销。

DO 保存配对、网页会话和路由授权；KV 保存 OAuth Provider 状态。备份部署配置并保护 secret。首版不提供 CF/VPS 之间的状态迁移工具。删除存储需要重新配对和授权；撤销不停止原生任务。

验收需要公网 `/health`、网页登录、设备配对，以及目标 MCP 客户端实际调用 `instances_list`。本地 workerd 测试不能代替你的云账号与客户端验收。

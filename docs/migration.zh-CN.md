# 旧版本迁移

[English](migration.md) · [README](../README.zh-CN.md)

本指南用于以 Siyin 名称安装、或仍使用所有者密钥对认证的部署。新安装直接使用部署指南。

## Connector

显式指定原配置目录，Agenvo 不会自动搬移：

```sh
export AGENVO_CONFIG_DIR="$HOME/.config/siyin"
node /absolute/path/to/agenvo/dist/cli.js status --json
```

目录选择顺序为 `AGENVO_CONFIG_DIR`、`SIYIN_CONFIG_DIR`、默认的 `~/.config/agenvo`。保留配置中的 Herdr 根目录和 Codex HOME。

替换 Connector 前先结束托管 Codex 的活跃轮次：停止 Connector 会停止托管进程，但不会停止独立的 Herdr 和附着的 Codex 服务。用旧 CLI 和原配置执行 `service uninstall`，再用新 CLI 和同一配置执行 `service install`。旧 CLI 不可用时，先移除对应的 `io.siyin.connector.*` launchd/systemd unit。不要让两个 Connector 共用配置。

Codex 现在固定使用 full access。旧 `policy` 字段会被丢弃，不再支持 `--sandbox` 和 `--approval-policy`。在 `/admin` 批准变化的实例指纹，再重新读取 `instance_describe`。不声明 `managementVersion` 的旧 Connector 仅支持原生方法。未发布的 `agents.*`、`runs.*` 已替换为 `management.threads.*`。Herdr 新启动支持 Codex、Claude 和 Devin，其他已运行的 Agent 类型仍可发现。

## Relay

保留 origin 和持久状态以保留设备凭据及 OAuth 授权。管理员认证改用共享密钥，不再接受旧所有者签名密钥。

- **Cloudflare：**保留 Worker 名称、KV ID、DO 绑定和迁移历史。将 manifest 的 `main` 指向新 checkout 的 `src/relay/worker.ts`。移除 `OWNER_PUBLIC_KEY`、`OWNER_EMAIL`、`ACCESS_ISSUER`、`ACCESS_AUD`，将 `secrets.required` 设为 `["ADMIN_SECRET"]`。通过 Wrangler 设置该 secret，使用原 manifest 部署。移除旧 Access 登录拦截后验证 `/admin`。
- **VPS：**停止 Relay 并备份整个数据目录。保留 origin、数据路径、Compose 项目和 volume、服务用户。删除 Relay JSON 中的 `ownerPublicKey`，通过[部署环境](deployment-vps.zh-CN.md)提供 `AGENVO_ADMIN_SECRET`，使用新程序重启。

不要重命名 `SiyinRelay` DO 类或 `siyin.sqlite` 数据库，它们仍是存储兼容标识。不支持 Cloudflare/VPS 状态自动迁移。

部署使用 Wrangler/Compose/systemd，客户端登录使用 MCP 客户端自身的浏览器 OAuth 流程。旧 `agenvo deploy` 和 `agenvo client` 命令不再提供。验证 `/health`、管理员登录和 MCP 客户端的 `instances_list` 后，再清理旧所有者密钥文件。

更换域名时更新 Connector URL 和客户端配置，再[重新连接 ChatGPT](chatgpt.zh-CN.md)。验证新连接后才删除旧部署。升级中断的写操作应先查询原生状态，再决定是否重试。

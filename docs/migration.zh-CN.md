# 旧版本迁移

[English](migration.md) · [README](../README.zh-CN.md)

本指南用于旧的单一 Agenvo Connector、Siyin 安装，或仍使用所有者密钥对认证的部署。新安装直接使用部署指南。

## Connector

旧的 `agenvo` 程序拆为 `agenvo-herdr`、`agenvo-codex-app-server`；服务端使用 `agenvo-server`。先构建新版本，保留旧程序和配置备份。新默认目录为 `~/.config/agenvo/herdr` 与 `~/.config/agenvo/codex-app-server`，不会自动读取旧目录。`SIYIN_CONFIG_DIR` 不再作为隐式回退。

**原配置只有一个后端：**用旧程序和原配置执行 `service uninstall`，再用对应的新程序显式选择原目录。配置、配对身份与实例指纹可以保留，例如 Herdr：

```sh
export AGENVO_CONFIG_DIR="$HOME/.config/agenvo"
node /absolute/path/to/agenvo/apps/herdr/dist/cli.js status --json
node /absolute/path/to/agenvo/apps/herdr/dist/cli.js service install
```

**原配置混合了两个后端：**先停止旧 Connector，将 `config.json` 的 `instances` 保留为其中一个后端，使用对应的新程序和原目录接管原身份。另一个后端在其新默认目录重新配置实例并独立配对。保留原 Herdr 根目录和 Codex HOME；不要复制 `deviceId`、`credentials.json` 或待配对状态给第二个 Connector。验证新连接后，在管理页撤销旧身份上不再使用的实例授权。

停止 Connector 会停止其托管 Codex 进程；先结束活跃轮次。独立 Herdr 和 attach 模式的 Codex 服务继续运行。系统服务名称按配置目录区分；复用原目录前必须卸载旧服务。旧 CLI 不可用时，先移除其确切的 launchd/systemd unit。不能让两个进程共用同一个配置目录或配对身份。

Codex 现在固定使用 full access。旧 `policy` 字段会被丢弃，不再支持 `--sandbox` 和 `--approval-policy`。在 `/admin` 批准变化的实例指纹，再重新读取 `instance_describe`。不声明 `managementVersion` 的旧 Connector 仅支持原生方法。未发布的 `agents.*`、`runs.*` 已替换为 `management.threads.*`。Herdr 新启动支持 Codex、Claude 和 Devin，其他已运行的 Agent 类型仍可发现。

## Relay

保留 origin 和持久状态以保留设备凭据及 OAuth 授权。管理员认证改用共享密钥，不再接受旧所有者签名密钥。

- **Cloudflare：**保留 Worker 名称、KV ID、DO 绑定和迁移历史。将 manifest 的 `main` 指向新 checkout 的 `apps/cloudflare/src/worker.ts`。移除 `OWNER_PUBLIC_KEY`、`OWNER_EMAIL`、`ACCESS_ISSUER`、`ACCESS_AUD`，将 `secrets.required` 设为 `["ADMIN_SECRET"]`。通过 Wrangler 设置该 secret，使用原 manifest 部署。移除旧 Access 登录拦截后验证 `/admin`。
- **VPS：**停止 Relay 并备份整个数据目录。保留 origin、数据路径、Compose 项目和 volume、服务用户。删除 Relay JSON 中的 `ownerPublicKey`，通过[部署环境](deployment-vps.zh-CN.md)提供 `AGENVO_ADMIN_SECRET`，使用 `agenvo-server serve --config CONFIG` 重启。

不要重命名 `SiyinRelay` DO 类或 `siyin.sqlite` 数据库，它们仍是存储兼容标识。不支持 Cloudflare/VPS 状态自动迁移。

部署使用 Wrangler/Compose/systemd，客户端登录使用 MCP 客户端自身的浏览器 OAuth 流程。旧 `agenvo deploy` 和 `agenvo client` 命令不再提供。验证 `/health`、管理员登录和 MCP 客户端的 `instances_list` 后，再清理旧所有者密钥文件。

更换域名时更新 Connector URL 和客户端配置，再[重新连接 ChatGPT](chatgpt.zh-CN.md)。验证新连接后才删除旧部署。升级中断的写操作应先查询原生状态，再决定是否重试。

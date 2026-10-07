# 从嗣音迁移

[English](migration.md)

Agenvo 是嗣音 MCP Relay 的新名称，本仓库延续嗣音的代码历史。此前同名但功能不同的 Agenvo 项目保留在 [agenvo-legacy](https://github.com/Xuanwo/agenvo-legacy)，其二进制程序和配置不兼容本项目。替换已有 `agenvo` 命令前，先构建本仓库并核对 `node dist/cli.js --help`。

## 新安装

使用 `agenvo` 命令、`AGENVO_CONFIG_DIR`（默认 `~/.config/agenvo`）以及 Agenvo 部署文档。Cloudflare 从 `wrangler.jsonc` 复制本地部署清单；VPS Compose 的域名变量为 `AGENVO_DOMAIN`。Connector 用户服务采用 `io.agenvo.connector.` 前缀。

## 已有安装

仓库改名不会升级已部署的 Relay，也不会重启 Connector。在选定升级时间前，可以继续使用已有部署。构建新目录不会修改已安装服务。

保留原有 origin、设备配置、原生运行时路径、状态目录和 Cloudflare 资源 ID。三个 MCP 工具及协议版本 1 保持不变。协议请求头、心跳消息、`siyin.describe`、序列化错误名称、`SiyinRelay` Durable Object 类及 VPS 的 `siyin.sqlite` 文件名保留原值。这些是兼容标识，不是遗漏的品牌文字。

### 所有者与 Connector 配置

显式选用原配置目录：

```sh
export AGENVO_CONFIG_DIR="$HOME/.config/siyin"
node /absolute/path/to/agenvo/dist/cli.js status --json
```

目录选择顺序是 `AGENVO_CONFIG_DIR`、旧变量 `SIYIN_CONFIG_DIR`、默认目录 `~/.config/agenvo`。Agenvo 不会自动发现或复制 `~/.config/siyin`。不要仅因项目改名就改变配置中的 Codex HOME 或 Herdr 根目录。

升级后台服务前，先结束活跃的托管 Codex turn。用旧 CLI 和原配置目录执行 `service uninstall`，停止原来的 `io.siyin.connector.*` 服务；再用新 CLI、指向同一目录的 `AGENVO_CONFIG_DIR` 执行 `service install`。手动启动的 Connector 也需要先停止。禁止两个服务同时使用同一配置。Herdr 继续独立运行；停止托管 Codex Connector 会停止其托管进程。旧 CLI 不可用时，应先停止并移除对应的准确 launchd/systemd unit，再安装新服务。

### Cloudflare

保留原 Worker 名称、ORIGIN、KV ID、DO 绑定与迁移记录。把旧 manifest 的 `main` 改为新 checkout 的 `src/relay/worker.ts`，删除 `OWNER_PUBLIC_KEY`、`OWNER_EMAIL`、`ACCESS_ISSUER`、`ACCESS_AUD` 等旧变量，设置 `secrets.required` 为 `["ADMIN_SECRET"]`。通过 Wrangler secret 注入新的管理员密钥，使用 `npx wrangler deploy --config EXISTING_MANIFEST` 部署。撤销旧 Access 登录拦截后，用 `/admin` 验证内置登录。

不要为了升级重新创建存储。保持同一个 ORIGIN 时，已有设备凭据和 OAuth grant 保留；管理私钥不再被接受。域名变更属于独立迁移，需要重新配置和验收客户端。

### 单 VPS

切换可执行文件前，停止原 Relay 并备份完整状态目录。复用原 Relay JSON 配置、origin、数据目录和 `siyin.sqlite`，包括其 WAL/SHM 文件。数据库只能由一个进程持有。更换 Compose 代码目录时保留 Compose project name 与 volume 映射，确保仍挂载原数据和 Caddy volume，并将 `AGENVO_DOMAIN` 设为原域名。systemd 部署更新已安装 unit 的可执行文件路径，保留其运行用户和状态权限；新的 `agenvo.service` 模板用于新安装，不能直接替代既有部署的路径配置。

升级后检查 `/health`，执行 `agenvo admin state --origin https://YOUR_EXISTING_RELAY`，并从原 MCP 客户端调用 `instances_list`。健康检查的服务名称现在为 `agenvo`。升级中结果不确定的写操作，应先检查原生状态再决定是否重试。

## 管理员认证升级

VPS 配置删除 `ownerPublicKey`，在进程环境设置 `AGENVO_ADMIN_SECRET` 后重启。配置与数据目录不变。管理员通过网页登录，CLI 管理命令需要显式注入同一个密钥。`agenvo deploy` 与 `agenvo client login/inspect/approve/call` 已删除，分别使用平台部署工具和原 MCP 客户端的浏览器 OAuth。旧所有者密钥文件不会被自动删除，确认升级后由部署者安全归档或删除。

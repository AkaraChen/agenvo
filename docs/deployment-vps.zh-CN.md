# 单 VPS 部署

[English](deployment-vps.md) · [README](../README.zh-CN.md)

准备一台 Linux VPS、指向它的公网域名、开放的 80/443 端口，以及 Docker Engine 和 Compose。Relay 只运行一个进程，不添加副本，不将 SQLite 放在网络文件系统上。编程运行时位于另行配对的设备上。

## 配置与启动

先按 README 构建 CLI。在所有者电脑上运行：

```sh
siyin relay init --origin https://relay.example.com \
  --data-dir /data --host 0.0.0.0 --port 8080 --trusted-proxy \
  --output deploy/vps/relay.local.json
```

命令生成 Relay 的公开配置，以及 `<SIYIN_CONFIG_DIR>/owner/<origin-hash>.json` 中的所有者私钥；`SIYIN_CONFIG_DIR` 默认是 `~/.config/siyin`。私钥留在所有者电脑上并安全备份。只将 `relay.local.json` 复制到 VPS 仓库的 `deploy/vps/relay.local.json`。配置和私钥都不提交到 Git。

在 VPS 的仓库根目录运行：

```sh
mkdir -p deploy/vps/data
sudo chown 1000:1000 deploy/vps/data deploy/vps/relay.local.json
sudo chmod 700 deploy/vps/data
sudo chmod 600 deploy/vps/relay.local.json
export SIYIN_DOMAIN=relay.example.com
docker compose -f deploy/vps/compose.yaml up -d --build
curl --fail https://relay.example.com/health
```

镜像中的 `node` 用户 UID 为 1000。Caddy 自动申请和续期公网证书。只有 Caddy 暴露端口，不应暴露 8080。代理必须保留原始 Host 请求头。容器日志记录生命周期，不记录原生任务输出。后续 Compose 命令仍需导出域名，也可保存到 `deploy/vps/.env`。

随后[配对设备并授权 MCP 客户端](usage.zh-CN.md)。VPS 通过签名 CLI 管理，浏览器授权页会说明如何批准页面地址，不依赖 Cloudflare Access。

## 不使用 Docker

安装 Node.js 24.13+，在 `/opt/siyin` 构建仓库。创建独立的 `siyin` 系统用户，将 `/var/lib/siyin` 设为该用户所有、权限 0700，并准备该用户可读的 `/etc/siyin/relay.json`。生成配置时使用 `--data-dir /var/lib/siyin --host 127.0.0.1 --trusted-proxy`，只将这份配置传到服务器。按实际 Node 路径调整并安装 [siyin.service](../deploy/vps/siyin.service)，通过 systemd 启动。Caddy 或其他 HTTPS 代理转发到 `127.0.0.1:8080`，保留 Host 和 WebSocket 升级头。

配置也可增加 `tls` 对象，以绝对路径指定 `cert` 和 `key`，由 `relay serve` 直接提供 TLS。证书续期和轮换后重启由运维者负责。HTTP 只用于内部代理链路，公网地址和 Connector 连接必须使用 HTTPS/WSS。

## 升级、备份与恢复

文件备份前先停止 Relay，复制整个数据目录、公开配置和代理配置。所有者私钥另行加密备份。运行期间不能只复制 `siyin.sqlite`，较新的事务可能仍在 WAL 文件中。

升级前制作停机备份，然后构建新镜像，在同一 Compose 项目中复用数据目录启动。数据库保留设备配对和 OAuth 授权。重启中断的在途调用结果不确定，重复写操作前先查询原生状态。Connector 会自动重连，Herdr 独立运行。升级失败时恢复旧镜像和对应备份。服务启动时检查数据库版本；首版不提供两种部署间的状态迁移工具。

SQLite 排他锁阻止第二个 Relay 使用同一数据库。首版不支持多进程扩容、共享网络磁盘或自动故障转移。动态 OAuth 客户端注册有容量限制，本部署面向个人使用，不面向匿名多租户托管。

## 代理与 OAuth 限制

`--trusted-proxy` 只信任一层反向代理，并按其转发的客户端地址限流。只有 Relay 完全位于该代理之后、外界不能绕过代理直连时才启用；代理必须覆盖不可信的转发头。Caddy 的默认代理配置提供此边界。直接 TLS 部署应保持关闭，此时忽略传入的转发头。公开配对每个客户端地址每十分钟最多十次。未配置可信代理时，代理后所有客户端共用该限制。

VPS OAuth 回调只支持 HTTPS 或回环 HTTP，不支持应用自定义 scheme。未经批准的注册一小时后过期，等待过久需要客户端重新注册。已过期的 confidential client secret 对应注册会自动清理；所有者批准的 public client 保留注册。注册容量为 256，并受 SDK 的每客户端地址限流约束。所有者签名允许五秒时钟偏差，声明的有效期仍不得超过 60 秒。

未发布开发版本创建的数据目录不属于受支持的升级来源；这类测试部署应重新创建并配对。VPS 的首个发布格式从当前实现开始。

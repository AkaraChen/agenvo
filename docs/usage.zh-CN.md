# 连接设备与客户端

[English](usage.md) · [README](../README.zh-CN.md)

以下命令假设 Relay 已部署到 `https://relay.example.com`。所有者与设备可以是不同电脑。`AGENVO_CONFIG_DIR` 选择本次安装的配置目录，Herdr 默认使用 `~/.config/agenvo/herdr`，Codex 使用 `~/.config/agenvo/codex-app-server`。每个 Connector 独立配对、持有凭据并安装服务；不要让两个 Connector 共享同一个目录或复制同一份凭据。

连接器命令尚未安装时，先按[安装指南](installation.zh-CN.md)完成构建。

## 配置运行时

先通过 Herdr 自身应用或服务独立启动 Herdr，再共享整个配置环境：

```sh
agenvo-herdr instance add --id work --config-root "$HOME/.config/herdr" --cwd "$HOME/code"
```

路径必须指向原生的 `herdr` 目录。Connector 发现其中运行的 session；停止 Connector 不会停止 Herdr。

使用独立的、由 Connector 管理的 Codex app-server：

```sh
mkdir -p "$HOME/.config/agenvo/codex-app-server/codex/coding"
CODEX_HOME="$HOME/.config/agenvo/codex-app-server/codex/coding" codex login
agenvo-codex-app-server instance add --id coding --home "$HOME/.config/agenvo/codex-app-server/codex/coding" --cwd "$HOME/code"
```

Codex 工作固定使用 `danger-full-access` 和 `approvalPolicy: never`，包括 attach 模式中的 thread 创建、恢复和新输入。执行权限请求自动回答。需要内容的用户问题和动态工具调用继续作为显式交互。

实验性的 `--mode attach-unix --socket /absolute/control.sock` 要求你已独立配置兼容的 Codex 控制端点。桌面 App 的 stdio 进程不会自动提供这个端点。attach 模式不启停该服务；默认使用上面的托管模式。

## 配对与运行

下例使用 Herdr；Codex 将命令替换成 `agenvo-codex-app-server`，单独完成相同步骤。两个 Connector 可以在同一台电脑同时运行。管理页分别显示它们，协议中的 `deviceId` 标识 Connector，不代表物理电脑。

```sh
agenvo-herdr connect https://relay.example.com --name laptop
```

命令打开管理页并等待。用管理员密钥登录，核对终端与页面的设备指纹及实例，点击批准。配对完成后，用 `agenvo-herdr run` 在前台运行，或用 `agenvo-herdr service install` 安装后台服务。

无浏览器设备使用 `--no-browser`，在另一台电脑打开输出的批准链接；设备无需持有管理员密钥。`--no-wait` 可先返回，批准后再次运行 connect。Linux 用户服务需要开启 linger 才能在注销后继续运行。

添加或修改实例后重启 Connector，在 `/admin` 批准新的实例范围。管理页也提供设备、实例和客户端授权撤销。

## 授权 MCP 客户端

在支持 OAuth 动态注册、S256 PKCE 与 Streamable HTTP 的客户端中添加 `https://relay.example.com/mcp`。浏览器打开 Agenvo 后登录并核对客户端、回调和范围，点击允许，自动返回客户端。访问 token 有效 15 分钟，grant 最长 30 天；所有有效客户端均可访问所有已批准实例。

## 可选管理自动化

只有显式管理操作需要在管理终端安全注入 `AGENVO_ADMIN_SECRET`。不要将它写入 Connector 配置、服务定义或命令行参数。可用命令：

```sh
agenvo-herdr pairing list --origin https://relay.example.com
agenvo-herdr pairing approve CODE --fingerprint SHA256 --origin https://relay.example.com
agenvo-herdr admin state --origin https://relay.example.com
agenvo-herdr admin approve-instance --device-id DEVICE --instance-id INSTANCE --fingerprint SHA256 --origin https://relay.example.com
```

`connect --approve` 仅用于已经显式提供管理员密钥的可信管理终端。远程设备的配对可由管理终端批准，无需把管理员密钥传给设备。

任务操作见[管理 Agent 会话](management.zh-CN.md)。

## 撤销与诊断

```sh
agenvo-herdr admin revoke grant --id GRANT_ID --origin https://relay.example.com
agenvo-herdr admin revoke instance --id DEVICE_ID --instance-id INSTANCE_ID --origin https://relay.example.com
agenvo-herdr admin revoke device --id DEVICE_ID --origin https://relay.example.com
agenvo-herdr status --json
agenvo-herdr doctor
agenvo-herdr disconnect
```

撤销阻止后续访问和在途结果交付，不撤回或停止已派发的本地工作。`disconnect` 清除本机凭据并尝试云端撤销，需检查返回的 `cloudRevoked` 和 `serviceUninstalled`。云端撤销失败时，网络恢复后通过所有者 CLI 撤销设备。

Connector 崩溃可能留下 `run.lock`。确认进程已退出后才执行 `agenvo-herdr doctor --recover-lock`，不要删除活跃进程的锁。调用返回 `unknown` 时先查看原生状态再决定是否重复写入。Connector 重启会使待处理输入的句柄失效，需要重新发现原生状态，不能重放旧答案。

Codex 0.160.1 可能对 `thread/turns/list` 或 `includeTurns: true` 的 `thread/read` 返回 `list_turns is not supported yet`。读取元数据时不传 `includeTurns`。

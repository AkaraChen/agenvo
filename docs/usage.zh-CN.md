# 连接设备与客户端

[English](usage.md) · [README](../README.zh-CN.md)

以下命令假设 Relay 已部署到 `https://relay.example.com`。所有者与设备可以是不同电脑。`AGENVO_CONFIG_DIR` 选择本次安装的配置目录，默认 `~/.config/agenvo`，不要让多个 Connector 进程同时共享它。

网页根据浏览器的语言偏好（`Accept-Language`）自动选择语言：中文偏好显示简体中文，英文偏好显示英文，未匹配时默认英文。每页只显示一种语言。

## 配置运行时

先通过 Herdr 自身应用或服务独立启动 Herdr，再共享整个配置环境：

```sh
agenvo instance add herdr --id work --config-root "$HOME/.config/herdr" --cwd "$HOME/code"
```

路径必须指向原生的 `herdr` 目录。Connector 发现其中运行的 session，并可创建工作区和 Agent。Agenvo 不提供 `session.start` 或 `session.stop`；停止 Connector 不会停止 Herdr。

使用独立的、由 Connector 管理的 Codex app-server：

```sh
mkdir -p "$HOME/.config/agenvo/codex/coding"
CODEX_HOME="$HOME/.config/agenvo/codex/coding" codex login
agenvo instance add codex --id coding --home "$HOME/.config/agenvo/codex/coding" --cwd "$HOME/code"
```

Codex 工作固定使用 `danger-full-access` 和 `approvalPolicy: never`，包括 attach 模式中的 thread 创建、恢复和新输入。执行权限请求自动回答。旧 sandbox/approval-policy CLI 选项已删除，旧配置中的 `policy` 在加载时丢弃。需要内容的用户问题和动态工具调用继续作为显式交互。

实验性的 `--mode attach-unix --socket /absolute/control.sock` 可连接已有 Codex 控制端点，不启停该服务，对通过 Agenvo 提交的工作应用 full access。桌面 App 已有的 stdio 进程不会自动提供这个端点。Agenvo 不配置或重启桌面 App；只有在你独立配置并验证兼容端点后才使用 attach，通常使用托管模式。

## 配对与运行

```sh
agenvo connect https://relay.example.com --name laptop
```

命令打开管理页并等待。用管理员密钥登录，核对终端与页面的设备指纹及实例，点击批准。CLI 自动完成配对，然后执行 `agenvo run` 或 `agenvo service install`。无浏览器设备使用 `--no-browser`，在自己的浏览器打开输出的 approvalUrl；`--no-wait` 可先返回，批准后再次运行 connect。普通设备无需管理员密钥。Linux 用户服务注销后保活需要管理员开启 linger。

添加或修改实例后重启 Connector，在 `/admin` 批准新的实例范围。管理页也提供设备、实例和客户端授权撤销。

## 授权 MCP 客户端

在支持 OAuth 动态注册、S256 PKCE 与 Streamable HTTP 的客户端中添加 `https://relay.example.com/mcp`。浏览器打开 Agenvo 后登录并核对客户端、回调和范围，点击允许，自动返回客户端。无需复制授权 URL、执行批准命令或打开回调文件。访问 token 有效 15 分钟，grant 最长 30 天；所有有效客户端均可访问所有已批准实例。

## 可选管理自动化

只有显式管理操作需要在管理终端安全注入 `AGENVO_ADMIN_SECRET`。不要将它写入 Connector 配置、服务定义或命令行参数。可用命令：

```sh
agenvo pairing list --origin https://relay.example.com
agenvo pairing approve CODE --fingerprint SHA256 --origin https://relay.example.com
agenvo admin state --origin https://relay.example.com
agenvo admin approve-instance --device-id DEVICE --instance-id INSTANCE --fingerprint SHA256 --origin https://relay.example.com
```

`connect --approve` 仅用于已经显式提供管理员密钥的可信管理终端。远程设备的配对可由管理终端批准，无需把管理员密钥传给设备。

共同接口流程见[管理 Agent 会话](management.zh-CN.md)。先发现后端能力，再调用已声明的方法；原生方法继续用于服务特有操作。使用 `management.threads.*` 和返回的 `threadRef`，通过 `threads.observe` 轮询状态、输出和待回应请求。结果不确定时先查询而不是重发，并检查观察记录的 gap。Herdr 的 idle 不代表任务完成。

## 撤销与诊断

```sh
agenvo admin revoke grant --id GRANT_ID --origin https://relay.example.com
agenvo admin revoke instance --id DEVICE_ID --instance-id INSTANCE_ID --origin https://relay.example.com
agenvo admin revoke device --id DEVICE_ID --origin https://relay.example.com
agenvo status --json
agenvo doctor
agenvo disconnect
```

撤销阻止后续访问和在途结果交付，不撤回或停止已派发的本地工作。`disconnect` 清除本机凭据并尝试云端撤销，需检查返回的 `cloudRevoked` 和 `serviceUninstalled`。云端撤销失败时，网络恢复后通过所有者 CLI 撤销设备。

Connector 崩溃可能留下 `run.lock`。确认进程已退出后才执行 `agenvo doctor --recover-lock`，不要删除活跃进程的锁。调用返回 `unknown` 时先查看原生状态再决定是否重复写入。Connector 重启会使待处理输入的句柄失效，需要重新发现原生状态，不能重放旧答案。

Codex 0.160.1 可能对 `thread/turns/list` 或 `includeTurns: true` 的 `thread/read` 返回 `list_turns is not supported yet`。读取元数据时不传 `includeTurns`。原生 schema 中声明的可选能力不保证后端已全部实现。

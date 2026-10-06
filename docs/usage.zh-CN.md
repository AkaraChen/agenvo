# 连接设备与客户端

[English](usage.md) · [README](../README.zh-CN.md)

以下命令假设 Relay 已部署到 `https://relay.example.com`。所有者与设备可以是不同电脑。`SIYIN_CONFIG_DIR` 选择本次安装的配置目录，默认 `~/.config/siyin`，不要让多个 Connector 进程同时共享它。

## 配置运行时

先通过 Herdr 自身应用或服务独立启动 Herdr，再共享整个配置环境：

```sh
siyin instance add herdr --id work --config-root "$HOME/.config/herdr" --cwd "$HOME/code"
```

路径必须指向原生的 `herdr` 目录。Connector 发现其中运行的 session，并可创建工作区和 Agent。嗣音不提供 `session.start` 或 `session.stop`；停止 Connector 不会停止 Herdr。

使用独立的、由 Connector 管理的 Codex app-server：

```sh
mkdir -p "$HOME/.config/siyin/codex/coding"
CODEX_HOME="$HOME/.config/siyin/codex/coding" codex login
siyin instance add codex --id coding --home "$HOME/.config/siyin/codex/coding" --cwd "$HOME/code" --sandbox read-only
```

如果 Codex 登录要求目录已经存在，先创建目录。`--sandbox workspace-write` 和 `--approval-policy untrusted|on-request` 配置托管实例的本地权限上限，变更前应理解原生权限。远程调用不能提高这个上限。

实验性的 `--mode attach-unix --socket /absolute/control.sock` 可连接已有 Codex 控制端点，不启停该服务，并保留原生 thread 权限。桌面 App 已有的 stdio 进程不会自动提供这个端点。嗣音不配置或重启桌面 App；只有在你独立配置并验证兼容端点后才使用 attach，通常使用托管模式。

## 配对与运行

在设备上运行并保持命令等待：

```sh
siyin connect https://relay.example.com --name laptop --no-browser
```

命令显示请求码和指纹。在所有者电脑上运行：

```sh
siyin pairing list --origin https://relay.example.com
siyin pairing approve CODE --fingerprint SHA256 --origin https://relay.example.com
```

必须与设备终端核对指纹，不能只依赖待批准列表。初次批准覆盖展示的实例。设备完成配对后运行 `siyin run`，或者使用 `siyin service install` 安装 macOS launchd/Linux systemd 用户服务。Linux 注销后保活依赖管理员开启 linger，嗣音不修改该主机策略。

添加或修改实例后，重启 Connector，检查并批准新的范围：

```sh
siyin admin state --origin https://relay.example.com
siyin admin approve-instance --device-id DEVICE --instance-id INSTANCE \
  --fingerprint SHA256 --origin https://relay.example.com
```

## 授权 MCP 客户端

客户端需支持 OAuth 动态注册、S256 PKCE 授权码流程和 Streamable HTTP。添加 `https://relay.example.com/mcp`，客户端打开授权地址后，在所有者电脑上执行：

```sh
siyin client inspect 'AUTHORIZATION_URL' --origin https://relay.example.com
siyin client approve 'AUTHORIZATION_URL' --origin https://relay.example.com \
  --client-id CLIENT_ID --redirect-uri 'EXACT_REDIRECT_URI' --output /private/path/consent.json
```

先核对客户端身份和准确回调地址。批准后打开权限为 0600 的文件中的 `redirectTo`，完成原客户端登录。地址包含短期授权码，不要粘贴到聊天、日志或 Git。输出文件必须尚不存在。访问令牌有效期 15 分钟；授权最长 30 天，也可提前撤销。授权覆盖所有已批准实例，不按项目或设备隔离。

MCP 工作流依次为发现实例、读取所选实例的方法说明、调用已经声明的方法。写操作后保留返回的原生 ID，通过原生 Agent/thread 状态和输出观察任务。Herdr 的 `idle` 不代表任务完成。Codex 在能力声明支持时提供结构化输入和审批，Herdr 使用原生终端交互。缺少输入不代表同意。

## 撤销与诊断

```sh
siyin admin revoke grant --id GRANT_ID --origin https://relay.example.com
siyin admin revoke instance --id DEVICE_ID --instance-id INSTANCE_ID --origin https://relay.example.com
siyin admin revoke device --id DEVICE_ID --origin https://relay.example.com
siyin status --json
siyin doctor
siyin disconnect
```

撤销阻止后续访问和在途结果交付，不撤回或停止已派发的本地工作。`disconnect` 清除本机凭据并尝试云端撤销，需检查返回的 `cloudRevoked` 和 `serviceUninstalled`。云端撤销失败时，网络恢复后通过所有者 CLI 撤销设备。

Connector 崩溃可能留下 `run.lock`。确认进程已退出后才执行 `siyin doctor --recover-lock`，不要删除活跃进程的锁。调用返回 `unknown` 时先查看原生状态再决定是否重复写入。Connector 重启会使待处理输入的句柄失效，需要重新发现原生状态，不能重放旧答案。

Codex 0.160.1 可能对 `thread/turns/list` 或 `includeTurns: true` 的 `thread/read` 返回 `list_turns is not supported yet`。读取元数据时不传 `includeTurns`。原生 schema 中声明的可选能力不保证后端已全部实现。

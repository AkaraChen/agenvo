# 参与贡献

[English](CONTRIBUTING.md)

使用 Node.js 24.13+ 和 `npm ci`。保持改动聚焦，说明用户可观察的行为。代码、标识符和注释使用英文；设计文档使用中文；用户指南提供英文与简体中文对应版本，行为变更时同时更新。面向用户和使用 Agenvo 的 Agent 的指南放在 `docs/`；面向开发者的设计文档放在顶层 `design/`。

```sh
npm ci
npm run check
npm run build
npm test
npm run test:integration
npm run test:packages
npm run format:check
npm audit
```

集成测试使用临时状态启动本地 workerd 和 Node 服务，经过真实 HTTP/WebSocket/MCP 入口，不需要 Cloudflare 账号。单元测试使用协议 fixture 验证故障路径。

修改适配器、事件投递或完整用户流程时，安装支持的原生二进制并运行系统测试：

```sh
node scripts/install-test-runtimes.mjs /tmp/agenvo-runtimes
# 按安装器输出设置 PATH。
npm run test:system
npm run test:adapters
```

安装器下载固定的 Herdr 0.9.3 和 Codex CLI 0.160.1，校验 Herdr 发布资产摘要。固定版本用于复现测试，不是运行时版本白名单。Linux/macOS CI 使用相同命令。`npm run test:ci` 将开头的检查（audit 除外）与系统测试合并。

系统测试覆盖 OAuth 登录 → 设备配对 → MCP 发现与订阅 → 输入任务 → 原生通知 → 读取输出 → 继续或中断 → 取消订阅。真实 Connector 和独立 Herdr/Codex 进程使用本地模型 mock。测试入口清除继承凭证，提供临时 HOME、CODEX_HOME 和 Herdr 配置，fixture 负责清理进程。不要将测试指向个人部署。Linux 用户服务测试需要 systemd 用户管理器；检查跳过输出以确认实际覆盖。

本地 webhook 接收端用测试密钥验证签名，测试专用地址映射让请求通过生产 HTTP 传输到达接收端。workerd 测试覆盖 Durable Object 存储和 alarm。这些测试不证明 ChatGPT UI 发现或实际 dot 唤醒；两者仍是独立的发布验收范围。

私有配置、凭据、原生日志和生成的构建产物不能进入 Git。

更新 Codex schema 时，使用 `scripts/import-codex-schema.py` 指定支持的 CLI 版本，并验证执行配置与适配器。

源码职责：

- `packages/protocol`：通信 schema、限制与执行结果。
- `packages/relay`：共享 Relay、MCP、事件投递与管理网页。
- `packages/connector`：共享连接、配置存储、观察与 CLI 机制。
- `apps/herdr`、`apps/codex-app-server`：独立 Connector，拥有各自的配置 schema 与适配器。
- `apps/server`、`apps/cloudflare`：VPS 与 Cloudflare 宿主。

新增部署宿主应复用路由核心，保留授权、epoch 和执行结果不确定的语义。新增适配器需要可发现的 schema 和明确的能力与交互语义，不添加可能重复写入的自动重试。

交付前检查私有路径与凭据，运行相关测试并说明验证缺口。每个 commit 表达一项连贯行为。生成的 schema 或依赖升级需说明来源和必要性。

兼容性只针对已正式对外发布的 Agenvo 版本，内部开发版本不作为兼容目标。详见 [AGENTS.md](AGENTS.md)。

三个发行包统一版本，内部 workspace 包保持 private 并在构建时打包。`npm run test:packages` 在临时目录安装真实 npm tarball，验证入口与后端隔离。测试不会发布 npm 包。

回归测试覆盖启动确认先于真实 Agent 就绪而超时、重新发现但不重复启动、没有受管启动元数据的 Agent 仍可发送、工作中备用屏幕历史读取回退到可见终端，以及原生错误、Relay 超时和 Connector 断线保留 requestId。测试身份、状态和凭据全部在本地生成；不要把事件截图、真实提示词或生产标识复制到测试中。客户端尚未发出 HTTP 请求时的取消，不属于服务端测试可证明的范围。

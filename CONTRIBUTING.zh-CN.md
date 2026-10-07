# 参与贡献

[English](CONTRIBUTING.md)

使用 Node.js 24.13+ 和 `npm ci`。保持改动聚焦，说明用户可观察的行为。代码、标识符和注释使用英文；设计文档使用中文；用户指南提供英文与简体中文对应版本，行为变更时同时更新。

```sh
npm ci
npm run check
npm run build
npm test
npm run test:integration
npm run format:check
npm audit
```

集成测试使用临时状态启动本地 workerd 和 Node 服务，经过真实 HTTP/WebSocket/MCP 入口，不需要 Cloudflare 账号。单元测试按需要使用确定性的原生服务 fixture。私有配置、凭据、原生日志和生成的构建产物不能进入 Git。

可选原生验证需要 Herdr 0.9.3、Codex CLI 0.160.1 及其正常平台依赖：

```sh
npm run test:adapters
npm run test:e2e
```

原生测试使用隔离 Herdr/Codex 环境和本地模型端点，不调用外部模型。`test:e2e` 可使用独立的 `AGENVO_E2E_CODEX_HOME`，不能指向日常 HOME 或生产服务。Linux 用户服务测试需要 systemd 用户管理器；检查跳过输出以确认实际覆盖。

更新 Codex schema 时，使用 `scripts/import-codex-schema.py` 指定支持的 CLI 版本，并验证执行配置与适配器。

源码职责：

- `src/protocol`：协议 schema、限制与执行结果。
- `src/relay`：可移植路由核心、MCP 与 Cloudflare 宿主。
- `src/server`：单进程 VPS 宿主、SQLite 与 OAuth。
- `src/connector`：设备生命周期与原生运行时适配器。
- `src/cli`：运行时配置、可选管理员命令和 Connector 服务集成。

新增部署宿主应复用路由核心，保留授权、epoch 和执行结果不确定的语义。新增适配器需要可发现的 schema 和明确的能力与交互语义，不添加可能重复写入的自动重试。

交付前检查私有路径与凭据，运行相关测试并说明验证缺口。每个 commit 表达一项连贯行为。生成的 schema 或依赖升级需说明来源和必要性。

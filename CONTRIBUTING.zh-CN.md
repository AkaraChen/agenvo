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

测试创建隔离环境。Linux 用户服务覆盖还需要可用的 systemd 用户管理器。声明原生覆盖前应核对测试条件与跳过输出，不能让测试连接日常运行时或生产 Relay。Codex schema 生成脚本 `scripts/import-codex-schema.py` 必须针对明确支持的 CLI 版本运行，随后验证权限策略和适配器。

源码职责：

- `src/protocol`：协议 schema、限制与执行结果。
- `src/relay`：可移植路由核心、MCP 与 Cloudflare 宿主。
- `src/server`：单进程 VPS 宿主、SQLite 与 OAuth。
- `src/connector`：设备生命周期与原生运行时适配器。
- `src/cli`：配置、所有者命令、服务与部署集成。

新增部署宿主应复用路由核心，保留授权、epoch 和执行结果不确定的语义。新增适配器需要可发现的 schema 和明确的输入、审批边界，不添加可能重复写入的自动重试。

交付前检查私有路径与凭据，运行相关测试并说明验证缺口。每个 commit 表达一项连贯行为。生成的 schema 或依赖升级需说明来源和必要性。

原生 Codex 覆盖初始化、schema 发现和权限拒绝。显式提供隔离的 `SIYIN_E2E_CODEX_HOME` 时，e2e 还验证 MCP 的 thread 创建、读取与归档。结构化输入和审批由确定性的 app-server fixture 覆盖，不声称可通过真实模型提示稳定触发。

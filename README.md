# Baton Automation Executor

`@lwmacct/260729-ba-executor` 是通用 Step Catalog Host。它可重复使用 `--pack` 加载
多个已安装 npm 包或本地模块，启动时合并步骤并拒绝重复 Step ID。Executor 不包含任何
OpenAI、Grok、Playwright 或特定 workflow 逻辑。

## 安装与 Pack 装配

```bash
pnpm add @lwmacct/260729-ba-executor @scope/example-step-pack
```

`--pack` 可重复传入已安装包的根名称或本地构建模块路径。每个模块必须默认导出一个
`defineStepPack(...)` 结果；启动时会校验 Pack 并合并 Catalog。Pack 的安装和分发方式
由对应仓库决定。

## HTTP Host

```bash
ba-executor serve \
  --pack @scope/example-step-pack \
  --pack ./dist/local-pack.js \
  --port 3000
```

HTTP API 位于 `/api`：

- `GET /api/health`：健康状态和已加载 Pack IDs。
- `GET /api/manifest`：版本化的合并 Step Catalog。
- `POST /api/steps/execute`：执行纯 Step invocation。
- `GET /api/auth/verify`：验证 Bearer Token。

默认监听 `127.0.0.1:3000`，也可用 `BA_EXECUTOR_PORT` 或 `--port` 修改端口。通过
`--host` 绑定非 loopback 地址时必须设置 `BA_EXECUTOR_TOKEN`；设置 token 后仅
`/api/health` 无需 `Authorization: Bearer <token>`。

## Baton CLI

```bash
ba-executor run \
  --pack @scope/example-step-pack \
  --context ./local.json \
  --entry example-entry \
  --mode continue
```

`--mode single` 只执行指定 entry；`--mode continue` 从指定 entry 继续执行后续计划。
CLI 会在每次状态转换后原子写回 Baton 文件。该文件可能包含凭据和执行结果，不应提交。

## 架构边界

- Context Baton 是 workflow 状态的唯一事实来源；Executor 不拥有 workflow 定义。
- Pack 决定 Step 能力；Executor 只负责加载、Catalog、输入/资源校验和执行。
- HTTP 请求只传输纯 invocation，Executor 不接收或回写完整 Baton。

## 验证

```bash
pnpm install
pnpm check
pnpm pack --pack-destination /tmp
```

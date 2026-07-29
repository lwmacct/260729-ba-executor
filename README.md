# Baton Automation Executor

`BA` 是 Browser Automation（浏览器自动化）的缩写。

`@lwmacct/260729-ba-executor` 是通用 Step Catalog Host。它可重复使用 `--pack` 加载
多个已安装 npm 包或本地包目录，启动时合并步骤并拒绝重复 Step ID。Executor 不包含任何
OpenAI、Grok、Playwright 或特定 workflow 逻辑。

## 安装与 Pack 装配

```bash
pnpm add @lwmacct/260729-ba-executor @scope/example-step-pack
```

`--pack` 可重复传入已安装包的根名称或包含 `package.json` 的本地包目录。包必须通过
根 `exports` 声明相对 ESM 入口，并默认导出 `defineStepPack(...)` 结果；启动时会校验
Pack 并合并 Catalog。任意 JavaScript 文件路径不再是合法 Pack 加载目标。

在 Step Pack 仓库完成构建后，可以直接加载当前包：

```bash
ba-executor serve --pack . --port 3000
```

## Pack 开发模式

```bash
ba-executor dev --pack . --port 3000
ba-executor dev --pack . --port 3000 --poll
```

`dev` 只接受一个本地 Pack 目录。该目录必须声明 `packageManager`、`scripts.build` 并包含
`src/`。Executor 使用 latest-wins 队列，只监听 `src/**/*.ts`、`package.json` 和已有的
`tsconfig*.json`，不监听 `node_modules`，也不跟随符号链接。每次变更依次执行构建、隔离
Pack 验证和 Host 重启。构建或验证失败时保留上一个可用 Host 并继续监听；新 Host 通过
readiness 消息确认启动。Host 使用独立进程，因此不会受到 ESM module cache 影响。

容器挂载目录无法稳定传递文件事件时使用 `--poll`，也可设置
`BA_EXECUTOR_DEV_POLL=1`。开发监督器会终止完整 POSIX 子进程组，避免中断构建时遗留
包管理器或编译器进程。

只验证已构建的 Pack 根导出而不启动 Host：

```bash
ba-executor validate --pack .
```

## HTTP Host

```bash
ba-executor serve \
  --pack @scope/example-step-pack \
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

# Baton Automation Executor

`@lwmacct/260729-ba-executor` 是通用 Step Catalog Host。它可重复使用 `--pack` 加载
多个已安装 npm 包或本地模块，启动时合并步骤并拒绝重复 Step ID。Executor 不包含任何
OpenAI、Grok、Playwright 或特定 workflow 逻辑。

```bash
ba-executor serve \
  --pack @lwmacct/260730-ba-steps-browser \
  --pack @lwmacct/260508-ba-steps-openai \
  --port 3000

ba-executor run \
  --pack @lwmacct/260730-ba-steps-browser \
  --pack @lwmacct/260508-ba-steps-openai \
  --context ./local.json --entry create-browser --mode continue
```

HTTP API 位于 `/api`。默认只监听 `127.0.0.1`。通过 `--host` 绑定非 loopback 地址时，
必须设置 `BA_EXECUTOR_TOKEN`；设置后除 `/health` 外均要求
`Authorization: Bearer <token>`。

```bash
pnpm install
pnpm check
```

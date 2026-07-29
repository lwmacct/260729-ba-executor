# Baton Automation Executor

`@lwmacct/260729-ba-executor` 是通用 workflow Step Bundle host。它通过默认导出加载
已安装的 npm 包或本地模块，不扫描 Step 目录，也不包含 OpenAI/Grok 业务代码。

```bash
ba-executor serve --bundle @lwmacct/260508-ba-steps-openai --port 3000
ba-executor run --bundle @lwmacct/260508-ba-steps-openai \
  --context ./local.json --entry create-browser --mode continue
```

HTTP API 位于 `/api`。`BA_EXECUTOR_TOKEN` 为空时不启用鉴权；设置后除 `/health`
外均要求 `Authorization: Bearer <token>`。

```bash
pnpm install
pnpm check
```

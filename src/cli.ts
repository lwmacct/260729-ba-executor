import { serve } from "@hono/node-server";
import { loadWorkflowBundle } from "./bundle.js";
import { createBundleExecutor } from "./executor.js";
import { runBatonFile } from "./run.js";
import { createExecutorServer } from "./server.js";

function namedArgument(argv: readonly string[], name: string) {
  const index = argv.indexOf(name);
  if (index < 0) return undefined;
  const value = argv[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${name} requires a value.`);
  return value;
}

function requiredArgument(argv: readonly string[], name: string) {
  const value = namedArgument(argv, name)?.trim();
  if (!value) throw new Error(`${name} is required.`);
  return value;
}

function portArgument(argv: readonly string[]) {
  const raw = namedArgument(argv, "--port") ?? process.env.BA_EXECUTOR_PORT ?? "3000";
  const port = Number(raw);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error(`Invalid executor port: ${raw}.`);
  }
  return port;
}

export async function runCli(argv = process.argv.slice(2)) {
  const [command, ...args] = argv;
  if (command !== "serve" && command !== "run") {
    throw new Error("Usage: ba-executor <serve|run> --bundle <package-or-path> [...options]");
  }
  const bundle = await loadWorkflowBundle(requiredArgument(args, "--bundle"));
  const executor = createBundleExecutor(bundle);
  if (command === "serve") {
    const port = portArgument(args);
    const app = createExecutorServer({ executor, token: process.env.BA_EXECUTOR_TOKEN });
    return serve({ fetch: app.fetch, port }, () => {
      console.log(`BA executor (${bundle.id}) listening on http://127.0.0.1:${port}/api`);
    });
  }
  const mode = namedArgument(args, "--mode") ?? "single";
  if (mode !== "single" && mode !== "continue") {
    throw new Error("--mode must be single or continue.");
  }
  const result = await runBatonFile({
    contextPath: requiredArgument(args, "--context"),
    entryId: requiredArgument(args, "--entry"),
    executor,
    mode,
  });
  console.log(JSON.stringify(result.baton, null, 2));
  return result;
}

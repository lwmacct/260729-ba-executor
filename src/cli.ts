import { serve } from "@hono/node-server";
import { startDevelopmentHost } from "./dev.js";
import { createCatalogExecutor } from "./executor.js";
import { loadStepPacks } from "./pack.js";
import { runBatonFile } from "./run.js";
import { createExecutorServer } from "./server.js";

function namedArgument(argv: readonly string[], name: string) {
  const index = argv.indexOf(name);
  if (index < 0) return undefined;
  const value = argv[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${name} requires a value.`);
  return value;
}

function repeatedArguments(argv: readonly string[], name: string) {
  const values: string[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] !== name) continue;
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`${name} requires a value.`);
    values.push(value);
    index += 1;
  }
  return values;
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

function hostArgument(argv: readonly string[]) {
  const host = (namedArgument(argv, "--host") ?? "127.0.0.1").trim();
  if (!host) throw new Error("--host requires a value.");
  return host;
}

function isLoopbackHost(host: string) {
  return host === "127.0.0.1" || host === "::1" || host === "localhost";
}

export async function runCli(argv = process.argv.slice(2)) {
  const [command, ...args] = argv;
  if (command !== "dev" && command !== "serve" && command !== "run") {
    throw new Error(
      "Usage: ba-executor <dev|serve|run> --pack <package-or-directory> [...options]",
    );
  }
  const packSpecifiers = repeatedArguments(args, "--pack");
  if (command === "dev") {
    if (packSpecifiers.length !== 1) {
      throw new Error("Development mode requires exactly one --pack directory.");
    }
    return startDevelopmentHost({
      packSpecifier: packSpecifiers[0]!,
      serveArgs: args,
    });
  }
  const packs = await loadStepPacks(packSpecifiers);
  const executor = createCatalogExecutor(packs);
  if (command === "serve") {
    const port = portArgument(args);
    const host = hostArgument(args);
    const token = process.env.BA_EXECUTOR_TOKEN?.trim();
    if (!isLoopbackHost(host) && !token) {
      throw new Error("BA_EXECUTOR_TOKEN is required when --host is not loopback.");
    }
    const app = createExecutorServer({ executor, token });
    return serve({ fetch: app.fetch, hostname: host, port }, () => {
      console.log(
        `BA executor (${packs.map((pack) => pack.id).join(", ")}) listening on http://${host}:${port}/api`,
      );
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

import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import chokidar, { type FSWatcher } from "chokidar";

type PackageManifest = {
  packageManager?: unknown;
  scripts?: unknown;
};

export type DevelopmentState =
  | "starting"
  | "building"
  | "validating"
  | "restarting"
  | "running"
  | "failed"
  | "closed";

export type DevelopmentHost = {
  close: () => Promise<void>;
  getState: () => DevelopmentState;
};

export type DevelopmentHostOptions = {
  cwd?: string;
  debounceMs?: number;
  mainModulePath?: string;
  packSpecifier: string;
  pollIntervalMs?: number;
  readinessTimeoutMs?: number;
  serveArgs: readonly string[];
  usePolling?: boolean;
  validationTimeoutMs?: number;
};

type ProcessResult = {
  code: number | null;
  signal: NodeJS.Signals | null;
};

function localPackageDirectory(specifier: string, cwd: string) {
  if (!specifier.startsWith(".") && !path.isAbsolute(specifier)) {
    throw new Error("Development mode requires one local Step Pack directory.");
  }
  const directory = path.resolve(cwd, specifier);
  const manifestPath = path.join(directory, "package.json");
  if (!fs.existsSync(directory) || !fs.statSync(directory).isDirectory()) {
    throw new Error(`Development Step Pack must be a package directory: ${specifier}.`);
  }
  if (!fs.existsSync(manifestPath)) {
    throw new Error(`Development Step Pack directory must contain package.json: ${specifier}.`);
  }
  return directory;
}

function buildCommand(directory: string) {
  const manifestPath = path.join(directory, "package.json");
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as PackageManifest;
  if (
    !manifest.scripts ||
    typeof manifest.scripts !== "object" ||
    !("build" in manifest.scripts) ||
    typeof (manifest.scripts as Record<string, unknown>).build !== "string" ||
    !(manifest.scripts as Record<string, string>).build.trim()
  ) {
    throw new Error("Development Step Pack package.json must define scripts.build.");
  }
  if (typeof manifest.packageManager !== "string") {
    throw new Error("Development Step Pack package.json must define packageManager.");
  }
  const manager = manifest.packageManager.match(/^([a-z0-9-]+)@/)?.[1];
  if (!manager || !["bun", "npm", "pnpm", "yarn"].includes(manager)) {
    throw new Error(`Unsupported packageManager for development mode: ${manifest.packageManager}.`);
  }
  return {
    command: process.platform === "win32" ? `${manager}.cmd` : manager,
    args: ["run", "build"],
  };
}

function processStatus(result: ProcessResult) {
  return result.signal ? `signal ${result.signal}` : `code ${result.code ?? "unknown"}`;
}

function waitForExit(child: ChildProcess) {
  return new Promise<ProcessResult>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
}

function signalProcess(child: ChildProcess, signal: NodeJS.Signals) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  if (process.platform !== "win32" && child.pid) {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") return;
    }
  }
  child.kill(signal);
}

async function stopProcess(child: ChildProcess | undefined) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  let resolveExit: () => void;
  const exited = new Promise<void>((resolve) => {
    resolveExit = resolve;
    child.once("exit", resolve);
  });
  if (child.exitCode !== null || child.signalCode !== null) {
    resolveExit!();
    return;
  }
  signalProcess(child, "SIGTERM");
  const stopped = await Promise.race([
    exited.then(() => true),
    new Promise<false>((resolve) => setTimeout(() => resolve(false), 2000)),
  ]);
  if (!stopped && child.exitCode === null && child.signalCode === null) {
    signalProcess(child, "SIGKILL");
    await exited;
  }
}

function developmentWatchPaths(directory: string) {
  const configPaths = fs.readdirSync(directory)
    .filter((name) => /^tsconfig(?:\.[^.]+)?\.json$/.test(name))
    .map((name) => path.join(directory, name));
  const sourceDirectory = path.join(directory, "src");
  if (!fs.existsSync(sourceDirectory) || !fs.statSync(sourceDirectory).isDirectory()) {
    throw new Error("Development Step Pack must contain a src directory.");
  }
  return {
    paths: [sourceDirectory, path.join(directory, "package.json"), ...configPaths],
    sourceDirectory,
  };
}

async function waitForWatcher(watcher: FSWatcher) {
  await new Promise<void>((resolve, reject) => {
    const handleReady = () => {
      watcher.off("error", handleError);
      resolve();
    };
    const handleError = (error: unknown) => {
      watcher.off("ready", handleReady);
      reject(error);
    };
    watcher.once("ready", handleReady);
    watcher.once("error", handleError);
  });
}

function waitForHostReady(child: ChildProcess, timeoutMs: number) {
  return new Promise<{ ready: boolean; reason?: string }>((resolve) => {
    let settled = false;
    const settle = (result: { ready: boolean; reason?: string }) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.off("error", handleError);
      child.off("exit", handleExit);
      child.off("message", handleMessage);
      resolve(result);
    };
    const handleError = (error: Error) => settle({ ready: false, reason: error.message });
    const handleExit = (code: number | null, signal: NodeJS.Signals | null) =>
      settle({ ready: false, reason: processStatus({ code, signal }) });
    const handleMessage = (message: unknown) => {
      if (
        message &&
        typeof message === "object" &&
        "type" in message &&
        message.type === "ba-executor-ready"
      ) {
        settle({ ready: true });
      }
    };
    const timer = setTimeout(
      () => settle({ ready: false, reason: `readiness timeout after ${timeoutMs}ms` }),
      timeoutMs,
    );
    child.once("error", handleError);
    child.once("exit", handleExit);
    child.on("message", handleMessage);
  });
}

export async function startDevelopmentHost(
  options: DevelopmentHostOptions,
): Promise<DevelopmentHost> {
  const cwd = path.resolve(options.cwd ?? process.cwd());
  const packageDirectory = localPackageDirectory(options.packSpecifier, cwd);
  buildCommand(packageDirectory);
  const mainModulePath = options.mainModulePath ?? fileURLToPath(new URL("./main.js", import.meta.url));
  let state: DevelopmentState = "starting";
  let watcher: FSWatcher | undefined;
  let pipelineProcess: ChildProcess | undefined;
  let hostProcess: ChildProcess | undefined;
  let debounceTimer: NodeJS.Timeout | undefined;
  let requestedGeneration = 0;
  let completedGeneration = 0;
  let pipeline: Promise<void> | undefined;
  let closePromise: Promise<void> | undefined;
  let closing = false;

  const transition = (nextState: DevelopmentState, message: string) => {
    state = nextState;
    const output = `BA executor dev [${nextState}] ${message}`;
    if (nextState === "failed") console.error(output);
    else console.log(output);
  };

  const spawnProcess = (
    command: string,
    args: readonly string[],
    processDirectory: string,
    stdio: "inherit" | ["ignore", "ignore", "inherit"],
  ) => spawn(command, args, {
    cwd: processDirectory,
    detached: process.platform !== "win32",
    env: process.env,
    stdio,
  });

  const runPipelineProcess = async (
    child: ChildProcess,
    timeoutMs?: number,
  ) => {
    pipelineProcess = child;
    let timeout: NodeJS.Timeout | undefined;
    if (timeoutMs) timeout = setTimeout(() => void stopProcess(child), timeoutMs);
    try {
      return await waitForExit(child);
    } finally {
      if (timeout) clearTimeout(timeout);
      if (pipelineProcess === child) pipelineProcess = undefined;
    }
  };

  const build = async () => {
    transition("building", packageDirectory);
    try {
      const command = buildCommand(packageDirectory);
      const result = await runPipelineProcess(
        spawnProcess(command.command, command.args, packageDirectory, "inherit"),
      );
      if (result.code === 0) return true;
      if (!closing) transition("failed", `build failed with ${processStatus(result)}; keeping the previous host.`);
    } catch (error) {
      if (!closing) transition("failed", error instanceof Error ? error.message : String(error));
    }
    return false;
  };

  const validate = async () => {
    transition("validating", options.packSpecifier);
    try {
      const result = await runPipelineProcess(
        spawnProcess(
          process.execPath,
          [mainModulePath, "validate", "--pack", options.packSpecifier],
          cwd,
          ["ignore", "ignore", "inherit"],
        ),
        options.validationTimeoutMs ?? 10000,
      );
      if (result.code === 0) return true;
      if (!closing) transition("failed", `Pack validation failed with ${processStatus(result)}; keeping the previous host.`);
    } catch (error) {
      if (!closing) transition("failed", error instanceof Error ? error.message : String(error));
    }
    return false;
  };

  const startHost = async () => {
    transition("restarting", options.packSpecifier);
    const child = spawn(process.execPath, [mainModulePath, "serve", ...options.serveArgs], {
      cwd,
      detached: process.platform !== "win32",
      env: { ...process.env, BA_EXECUTOR_DEV_CHILD: "1" },
      stdio: ["inherit", "inherit", "inherit", "ipc"],
    });
    hostProcess = child;
    const readiness = await waitForHostReady(child, options.readinessTimeoutMs ?? 5000);
    if (!readiness.ready || closing) {
      if (hostProcess === child) hostProcess = undefined;
      await stopProcess(child);
      if (!closing) transition("failed", `Host failed to start: ${readiness.reason ?? "unknown error"}.`);
      return false;
    }
    child.once("exit", (code, signal) => {
      if (!closing && child === hostProcess) {
        hostProcess = undefined;
        transition("failed", `Host stopped with ${processStatus({ code, signal })}; waiting for a change.`);
      }
    });
    transition("running", options.packSpecifier);
    return true;
  };

  const restart = async () => {
    const previousHost = hostProcess;
    hostProcess = undefined;
    await stopProcess(previousHost);
    if (!closing) await startHost();
  };

  const drainPipeline = () => {
    if (pipeline) return pipeline;
    pipeline = (async () => {
      while (!closing && completedGeneration < requestedGeneration) {
        const generation = requestedGeneration;
        completedGeneration = generation;
        if (!await build() || closing) continue;
        if (generation !== requestedGeneration) continue;
        if (!await validate() || closing) continue;
        if (generation !== requestedGeneration) continue;
        await restart();
      }
    })().finally(() => {
      pipeline = undefined;
      if (!closing && completedGeneration < requestedGeneration) void drainPipeline();
    });
    return pipeline;
  };

  const requestRebuild = () => {
    if (closing) return;
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      requestedGeneration += 1;
      void drainPipeline();
    }, options.debounceMs ?? 100);
  };

  const watchTargets = developmentWatchPaths(packageDirectory);
  watcher = chokidar.watch(watchTargets.paths, {
    awaitWriteFinish: { stabilityThreshold: 100, pollInterval: 25 },
    followSymlinks: false,
    ignoreInitial: true,
    ignored: (watchedPath, stats) => {
      if (!stats?.isFile()) return false;
      const relativeSourcePath = path.relative(watchTargets.sourceDirectory, watchedPath);
      const isSourceFile = relativeSourcePath &&
        !relativeSourcePath.startsWith("..") &&
        !path.isAbsolute(relativeSourcePath);
      return Boolean(isSourceFile) && !watchedPath.endsWith(".ts");
    },
    interval: options.pollIntervalMs ?? 250,
    usePolling: options.usePolling ?? false,
  });
  watcher.on("all", requestRebuild);
  await waitForWatcher(watcher);
  watcher.on("error", (error) => {
    if (!closing) transition("failed", `Watcher error: ${String(error)}.`);
  });

  const close = () => {
    if (closePromise) return closePromise;
    closing = true;
    closePromise = (async () => {
      if (debounceTimer) clearTimeout(debounceTimer);
      const activePipeline = pipeline;
      await Promise.all([
        watcher?.close(),
        stopProcess(pipelineProcess),
        stopProcess(hostProcess),
      ]);
      await activePipeline;
      transition("closed", packageDirectory);
    })();
    return closePromise;
  };

  const detachSignalHandlers = () => {
    process.off("SIGINT", handleSignal);
    process.off("SIGTERM", handleSignal);
  };
  const handleSignal = () => {
    detachSignalHandlers();
    void close();
  };
  process.once("SIGINT", handleSignal);
  process.once("SIGTERM", handleSignal);

  requestedGeneration = 1;
  await drainPipeline();
  return {
    close: async () => {
      detachSignalHandlers();
      await close();
    },
    getState: () => state,
  };
}

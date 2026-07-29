import { spawn, type ChildProcess } from "node:child_process";
import fs, { type FSWatcher } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

type PackageManifest = {
  packageManager?: unknown;
  scripts?: unknown;
};

export type DevelopmentHost = {
  close: () => Promise<void>;
};

export type DevelopmentHostOptions = {
  cwd?: string;
  debounceMs?: number;
  mainModulePath?: string;
  packSpecifier: string;
  serveArgs: readonly string[];
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

function waitForExit(child: ChildProcess) {
  return new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
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
  child.kill("SIGTERM");
  const stopped = await Promise.race([
    exited.then(() => true),
    new Promise<false>((resolve) => setTimeout(() => resolve(false), 2000)),
  ]);
  if (!stopped && child.exitCode === null && child.signalCode === null) {
    child.kill("SIGKILL");
    await exited;
  }
}

function watchDevelopmentFiles(directory: string, onChange: () => void) {
  const watchers: FSWatcher[] = [];
  const sourceDirectory = path.join(directory, "src");
  if (!fs.existsSync(sourceDirectory) || !fs.statSync(sourceDirectory).isDirectory()) {
    throw new Error("Development Step Pack must contain a src directory.");
  }
  watchers.push(fs.watch(sourceDirectory, { recursive: true }, onChange));
  watchers.push(fs.watch(directory, (_event, filename) => {
    if (
      filename === null ||
      filename === "package.json" ||
      /^tsconfig(?:\.[^.]+)?\.json$/.test(filename)
    ) {
      onChange();
    }
  }));
  return watchers;
}

export async function startDevelopmentHost(
  options: DevelopmentHostOptions,
): Promise<DevelopmentHost> {
  const cwd = path.resolve(options.cwd ?? process.cwd());
  const packageDirectory = localPackageDirectory(options.packSpecifier, cwd);
  buildCommand(packageDirectory);
  const mainModulePath = options.mainModulePath ?? fileURLToPath(new URL("./main.js", import.meta.url));
  const watchers: FSWatcher[] = [];
  let buildProcess: ChildProcess | undefined;
  let hostProcess: ChildProcess | undefined;
  let debounceTimer: NodeJS.Timeout | undefined;
  let building = false;
  let rebuildRequested = false;
  let closing = false;

  const startHost = () => {
    const child = spawn(process.execPath, [mainModulePath, "serve", ...options.serveArgs], {
      cwd,
      env: process.env,
      stdio: "inherit",
    });
    child.once("exit", (code, signal) => {
      if (!closing && child === hostProcess) {
        const status = signal ? `signal ${signal}` : `code ${code ?? "unknown"}`;
        console.error(`BA executor development host stopped with ${status}.`);
      }
    });
    child.once("error", (error) => console.error(error.message));
    hostProcess = child;
  };

  const rebuild = async () => {
    if (building) {
      rebuildRequested = true;
      return;
    }
    building = true;
    do {
      rebuildRequested = false;
      let result: Awaited<ReturnType<typeof waitForExit>>;
      try {
        const command = buildCommand(packageDirectory);
        console.log(`BA executor dev building ${packageDirectory}.`);
        buildProcess = spawn(command.command, command.args, {
          cwd: packageDirectory,
          env: process.env,
          stdio: "inherit",
        });
        result = await waitForExit(buildProcess);
      } catch (error) {
        console.error(error instanceof Error ? error.message : String(error));
        result = { code: null, signal: null };
      } finally {
        buildProcess = undefined;
      }
      if (closing) break;
      if (result.code === 0) {
        const previousHost = hostProcess;
        hostProcess = undefined;
        await stopProcess(previousHost);
        if (!closing) startHost();
      } else {
        const status = result.signal ? `signal ${result.signal}` : `code ${result.code ?? "unknown"}`;
        console.error(`BA executor dev build failed with ${status}; keeping the previous host.`);
      }
    } while (rebuildRequested && !closing);
    building = false;
  };

  const scheduleRebuild = () => {
    if (closing) return;
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => void rebuild(), options.debounceMs ?? 100);
  };

  watchers.push(...watchDevelopmentFiles(packageDirectory, scheduleRebuild));

  const close = async () => {
    if (closing) return;
    closing = true;
    if (debounceTimer) clearTimeout(debounceTimer);
    for (const watcher of watchers) watcher.close();
    await Promise.all([stopProcess(buildProcess), stopProcess(hostProcess)]);
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

  await rebuild();
  return {
    close: async () => {
      detachSignalHandlers();
      await close();
    },
  };
}

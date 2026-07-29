import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { applyBatonCommand, createBaton, createBatonEntry } from "@lwmacct/260729-ba-context-baton";
import { defineStepPack } from "@lwmacct/260729-ba-framework/pack";
import { defineStep, output, stepResult, stringInput } from "@lwmacct/260729-ba-framework/step";
import { createCatalogExecutor } from "./executor.js";
import { startDevelopmentHost } from "./dev.js";
import { loadStepPack } from "./pack.js";
import { runBatonFile } from "./run.js";
import { createExecutorServer } from "./server.js";

const echo = defineStep({
  id: "test/echo",
  type: "action",
  title: "Echo",
  inputs: { value: stringInput<true>({ label: "Value", required: true }) },
  outputs: { value: output({ label: "Value" }) },
  run: async ({ input }) => stepResult({ value: input.value }),
});
const pack = defineStepPack({ id: "test/core", steps: [echo] });
const executor = createCatalogExecutor([pack]);

async function waitUntil(condition: () => boolean, message: string) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(message);
}

test("loads the current Step Pack from a package directory", async (context) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "ba-pack-"));
  context.after(() => fs.rmSync(directory, { recursive: true }));
  fs.mkdirSync(path.join(directory, "dist"));
  fs.writeFileSync(
    path.join(directory, "package.json"),
    JSON.stringify({
      name: "@example/local-steps",
      type: "module",
      exports: { ".": { import: "./dist/index.js" } },
    }),
  );
  fs.writeFileSync(
    path.join(directory, "dist", "index.js"),
    `export default ${JSON.stringify({ kind: "step-pack", version: 1, id: "loaded", steps: [] })};\n`,
  );
  assert.equal((await loadStepPack(".", directory)).id, "loaded");

  const filePath = path.join(directory, "dist", "index.js");
  await assert.rejects(loadStepPack(filePath), /must be a package directory/);
});

test("requires a built root package export", async (context) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "ba-pack-invalid-"));
  context.after(() => fs.rmSync(directory, { recursive: true }));
  fs.writeFileSync(
    path.join(directory, "package.json"),
    JSON.stringify({ name: "@example/invalid-steps", type: "module" }),
  );
  await assert.rejects(
    loadStepPack(".", directory),
    /must define a relative root exports import/,
  );

  fs.writeFileSync(
    path.join(directory, "package.json"),
    JSON.stringify({
      name: "@example/invalid-steps",
      type: "module",
      exports: { ".": { import: "./dist/index.js" } },
    }),
  );
  await assert.rejects(loadStepPack(".", directory), /build the package first/);
});

test("loads an installed Step Pack relative to the deployment directory", async (context) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "ba-package-"));
  context.after(() => fs.rmSync(directory, { recursive: true }));
  const packageDirectory = path.join(directory, "node_modules", "@example", "steps");
  fs.mkdirSync(path.join(packageDirectory, "dist"), { recursive: true });
  fs.writeFileSync(
    path.join(packageDirectory, "package.json"),
    JSON.stringify({
      name: "@example/steps",
      type: "module",
      exports: { ".": { import: "./dist/index.js" } },
    }),
  );
  fs.writeFileSync(
    path.join(packageDirectory, "dist", "index.js"),
    `export default ${JSON.stringify({ kind: "step-pack", version: 1, id: "installed", steps: [] })};\n`,
  );
  assert.equal((await loadStepPack("@example/steps", directory)).id, "installed");
  await assert.rejects(loadStepPack("@example/missing", directory), /not installed/);
});

test("rebuilds and restarts a local Step Pack development host", async (context) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "ba-dev-"));
  context.after(() => fs.rmSync(directory, { recursive: true }));
  fs.mkdirSync(path.join(directory, "src"));
  fs.writeFileSync(path.join(directory, "src", "index.ts"), "export {};\n");
  fs.writeFileSync(
    path.join(directory, "package.json"),
    JSON.stringify({
      name: "@example/dev-steps",
      packageManager: "pnpm@11.17.0",
      scripts: { build: "node build.mjs" },
    }),
  );
  fs.writeFileSync(
    path.join(directory, "build.mjs"),
    `import fs from "node:fs";\nconst file = "build-count";\nconst count = fs.existsSync(file) ? Number(fs.readFileSync(file, "utf8")) : 0;\nfs.writeFileSync(file, String(count + 1));\n`,
  );
  const hostModulePath = path.join(directory, "host.mjs");
  fs.writeFileSync(
    hostModulePath,
    `import fs from "node:fs";\nfs.appendFileSync("host-runs", JSON.stringify({ pid: process.pid, args: process.argv.slice(2) }) + "\\n");\nsetInterval(() => {}, 1000);\n`,
  );

  const developmentHost = await startDevelopmentHost({
    cwd: directory,
    debounceMs: 20,
    mainModulePath: hostModulePath,
    packSpecifier: ".",
    serveArgs: ["--pack", ".", "--port", "31234"],
  });
  context.after(() => developmentHost.close());
  const hostRunsPath = path.join(directory, "host-runs");
  await waitUntil(() => fs.existsSync(hostRunsPath), "initial development host did not start");

  fs.writeFileSync(path.join(directory, "src", "index.ts"), "export const changed = true;\n");
  await waitUntil(
    () => fs.readFileSync(path.join(directory, "build-count"), "utf8") === "2",
    "source change did not trigger a rebuild",
  );
  await waitUntil(
    () => fs.readFileSync(hostRunsPath, "utf8").trim().split("\n").length === 2,
    "successful rebuild did not restart the host",
  );
  const runs = fs.readFileSync(hostRunsPath, "utf8").trim().split("\n").map((line) =>
    JSON.parse(line) as { args: string[]; pid: number }
  );
  assert.notEqual(runs[0]?.pid, runs[1]?.pid);
  assert.deepEqual(runs[1]?.args, ["serve", "--pack", ".", "--port", "31234"]);

  fs.writeFileSync(
    path.join(directory, "fail.mjs"),
    `import fs from "node:fs";\nfs.writeFileSync("build-failed", "true");\nprocess.exit(1);\n`,
  );
  fs.writeFileSync(
    path.join(directory, "package.json"),
    JSON.stringify({
      name: "@example/dev-steps",
      packageManager: "pnpm@11.17.0",
      scripts: { build: "node fail.mjs" },
    }),
  );
  await waitUntil(
    () => fs.existsSync(path.join(directory, "build-failed")),
    "failing build was not attempted",
  );
  assert.equal(fs.readFileSync(hostRunsPath, "utf8").trim().split("\n").length, 2);
  assert.doesNotThrow(() => process.kill(runs[1]!.pid, 0));

  fs.writeFileSync(
    path.join(directory, "package.json"),
    JSON.stringify({
      name: "@example/dev-steps",
      packageManager: "pnpm@11.17.0",
      scripts: { build: "node build.mjs" },
    }),
  );
  await waitUntil(
    () => fs.readFileSync(hostRunsPath, "utf8").trim().split("\n").length === 3,
    "development host did not recover after the build was fixed",
  );
  await developmentHost.close();
});

test("merges packs into a catalog and executes namespaced steps", async () => {
  const second = defineStepPack({ id: "test/empty", steps: [] });
  const catalog = createCatalogExecutor([pack, second]);
  const app = createExecutorServer({ executor: catalog });
  const manifest = await (await app.request("/api/manifest")).json() as {
    kind: string;
    packs: { id: string }[];
    version: number;
  };
  assert.equal(manifest.kind, "step-catalog-manifest");
  assert.equal(manifest.version, 1);
  assert.deepEqual(manifest.packs.map((item) => item.id), ["test/core", "test/empty"]);
  assert.equal((await app.request("/api/browser/check")).status, 404);
  const response = await app.request("/api/steps/execute", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      invocationId: "invoke",
      entryId: "entry",
      uses: "test/echo",
      input: { value: "hello" },
      resources: {},
      timeoutMs: 1000,
    }),
  });
  assert.deepEqual(await response.json(), {
    invocationId: "invoke",
    result: { status: "succeeded", output: { value: "hello" } },
  });
});

test("rejects duplicate step ids across packs", () => {
  assert.throws(
    () => createCatalogExecutor([pack, defineStepPack({ id: "test/copy", steps: [echo] })]),
    /Duplicate step id/,
  );
});

test("enforces bearer auth only when configured", async () => {
  const app = createExecutorServer({ executor, token: "secret" });
  assert.equal((await app.request("/api/health")).status, 200);
  assert.equal((await app.request("/api/manifest")).status, 401);
  assert.equal((await app.request("/api/manifest", { headers: { Authorization: "Bearer secret" } })).status, 200);
});

test("runs any Baton workflow and atomically persists its file", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "ba-executor-"));
  const contextPath = path.join(directory, "baton.json");
  let baton = createBaton({ id: "run", workflowId: "user-defined-workflow" });
  baton = applyBatonCommand(baton, {
    type: "entry.add",
    entry: createBatonEntry({ id: "echo", uses: "test/echo", input: { value: "file" } }),
  });
  fs.writeFileSync(contextPath, JSON.stringify(baton));
  const result = await runBatonFile({ contextPath, entryId: "echo", executor, mode: "single" });
  assert.equal(result.baton.entries[0]?.execution.status, "succeeded");
  const persisted = JSON.parse(fs.readFileSync(contextPath, "utf8")) as typeof baton;
  assert.deepEqual(persisted.entries[0]?.execution.output, { value: "file" });
});

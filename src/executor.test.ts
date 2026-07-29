import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { applyBatonCommand, createBaton, createBatonEntry } from "@lwmacct/260729-ba-context-baton";
import { defineStepPack } from "@lwmacct/260729-ba-framework/pack";
import { defineStep, output, stepResult, stringInput } from "@lwmacct/260729-ba-framework/step";
import { createCatalogExecutor } from "./executor.js";
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

test("loads a default-exported Step Pack from a module path", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "ba-pack-"));
  const packPath = path.join(directory, "pack.mjs");
  fs.writeFileSync(
    packPath,
    `export default ${JSON.stringify({ kind: "step-pack", version: 1, id: "loaded", steps: [] })};\n`,
  );
  assert.equal((await loadStepPack(packPath)).id, "loaded");
  const invalidPath = path.join(directory, "invalid.mjs");
  fs.writeFileSync(invalidPath, "export const value = true;\n");
  await assert.rejects(loadStepPack(invalidPath), /default export/);
});

test("loads an installed Step Pack relative to the deployment directory", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "ba-package-"));
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

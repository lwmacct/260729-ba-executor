import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createBaton, createBatonEntry, applyBatonCommand } from "@lwmacct/260729-ba-context-baton";
import { defineWorkflowBundle } from "@lwmacct/260729-ba-framework/bundle";
import { defineStep, output, stepResult, stringInput } from "@lwmacct/260729-ba-framework/step";
import { loadWorkflowBundle } from "./bundle.js";
import { createBundleExecutor } from "./executor.js";
import { runBatonFile } from "./run.js";
import { createExecutorServer } from "./server.js";

const echo = defineStep({
  id: "echo",
  type: "action",
  title: "Echo",
  inputs: { value: stringInput<true>({ label: "Value", required: true }) },
  outputs: { value: output({ label: "Value" }) },
  run: async ({ input }) => stepResult({ value: input.value }),
});
const executor = createBundleExecutor(defineWorkflowBundle({ id: "test", steps: [echo] }));

test("loads a default-exported bundle from a module path", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "ba-bundle-"));
  const bundlePath = path.join(directory, "bundle.mjs");
  fs.writeFileSync(
    bundlePath,
    `export default ${JSON.stringify({
      kind: "workflow-step-bundle",
      version: 1,
      id: "loaded",
      steps: [],
    })};\n`,
  );
  assert.equal((await loadWorkflowBundle(bundlePath)).id, "loaded");
  const invalidPath = path.join(directory, "invalid.mjs");
  fs.writeFileSync(invalidPath, "export const value = true;\n");
  await assert.rejects(loadWorkflowBundle(invalidPath), /default export/);
});

test("loads an installed bundle relative to the deployment directory", async () => {
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
    `export default ${JSON.stringify({
      kind: "workflow-step-bundle",
      version: 1,
      id: "installed",
      steps: [],
    })};\n`,
  );
  assert.equal(
    (await loadWorkflowBundle("@example/steps", directory)).id,
    "installed",
  );
  await assert.rejects(
    loadWorkflowBundle("@example/missing", directory),
    /not installed/,
  );
});

test("serves manifest v2 and executes bundle steps", async () => {
  const app = createExecutorServer({ executor });
  const manifest = await (await app.request("/api/manifest")).json() as { version: number };
  assert.equal(manifest.version, 2);
  assert.equal((await app.request("/api/steps")).status, 404);
  const response = await app.request("/api/steps/execute", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      invocationId: "invoke",
      entryId: "entry",
      uses: "echo",
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

test("enforces bearer auth only when configured", async () => {
  const app = createExecutorServer({ executor, token: "secret" });
  assert.equal((await app.request("/api/health")).status, 200);
  assert.equal((await app.request("/api/manifest")).status, 401);
  assert.equal((await app.request("/api/manifest", { headers: { Authorization: "Bearer secret" } })).status, 200);
});

test("runs and atomically persists a Baton file", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "ba-executor-"));
  const contextPath = path.join(directory, "baton.json");
  let baton = createBaton({ id: "run", workflowId: "test" });
  baton = applyBatonCommand(baton, {
    type: "entry.add",
    entry: createBatonEntry({ id: "echo", uses: "echo", input: { value: "file" } }),
  });
  fs.writeFileSync(contextPath, JSON.stringify(baton));
  const result = await runBatonFile({ contextPath, entryId: "echo", executor, mode: "single" });
  assert.equal(result.baton.entries[0]?.execution.status, "succeeded");
  const persisted = JSON.parse(fs.readFileSync(contextPath, "utf8")) as typeof baton;
  assert.deepEqual(persisted.entries[0]?.execution.output, { value: "file" });
});

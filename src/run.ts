import fs from "node:fs";
import path from "node:path";
import { parseBaton, type ContextBaton } from "@lwmacct/260729-ba-context-baton";
import { entryIdsFrom, runBatonEntries } from "@lwmacct/260729-ba-framework/controller";
import type { CatalogExecutor } from "./executor.js";

export type RunBatonFileOptions = {
  contextPath: string;
  entryId: string;
  executor: CatalogExecutor;
  mode: "continue" | "single";
  signal?: AbortSignal;
};

function readBaton(contextPath: string) {
  return parseBaton(JSON.parse(fs.readFileSync(contextPath, "utf8")));
}

function writeBatonAtomic(contextPath: string, baton: ContextBaton) {
  const directory = path.dirname(contextPath);
  const temporaryPath = path.join(
    directory,
    `.${path.basename(contextPath)}.${process.pid}.tmp`,
  );
  fs.writeFileSync(temporaryPath, `${JSON.stringify(baton, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temporaryPath, contextPath);
}

export async function runBatonFile(options: RunBatonFileOptions) {
  const contextPath = path.resolve(options.contextPath);
  const baton = readBaton(contextPath);
  const entryIds = options.mode === "continue"
    ? entryIdsFrom(baton, options.entryId)
    : [options.entryId];
  entryIdsFrom(baton, options.entryId);
  return runBatonEntries({
    baton,
    entryIds,
    execute: options.executor.execute,
    persist: ({ baton: next }) => writeBatonAtomic(contextPath, next),
    signal: options.signal,
  });
}

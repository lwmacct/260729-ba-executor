import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parseStepPack, type StepPack } from "@lwmacct/260729-ba-framework/pack";

function isPathSpecifier(specifier: string) {
  return specifier.startsWith(".") || path.isAbsolute(specifier);
}

function packageName(specifier: string) {
  const segments = specifier.split("/");
  if (specifier.startsWith("@")) {
    if (segments.length !== 2 || !segments[0] || !segments[1]) {
      throw new Error(`Step Pack specifier must name a package root: ${specifier}.`);
    }
    return segments.join("/");
  }
  if (segments.length !== 1 || !segments[0]) {
    throw new Error(`Step Pack specifier must name a package root: ${specifier}.`);
  }
  return segments[0];
}

function packageModuleUrl(specifier: string, cwd: string) {
  const name = packageName(specifier);
  let directory = path.resolve(cwd);
  while (true) {
    const packageDirectory = path.join(directory, "node_modules", name);
    const manifestPath = path.join(packageDirectory, "package.json");
    if (fs.existsSync(manifestPath)) {
      const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as {
        exports?: unknown;
        main?: unknown;
        module?: unknown;
      };
      const rootExport = manifest.exports && typeof manifest.exports === "object"
        ? (manifest.exports as Record<string, unknown>)["."]
        : manifest.exports;
      const conditionalExport = rootExport && typeof rootExport === "object"
        ? rootExport as Record<string, unknown>
        : undefined;
      const entry = typeof conditionalExport?.import === "string"
        ? conditionalExport.import
        : typeof conditionalExport?.default === "string"
          ? conditionalExport.default
          : typeof rootExport === "string"
            ? rootExport
            : typeof manifest.module === "string"
              ? manifest.module
              : typeof manifest.main === "string"
                ? manifest.main
                : "index.js";
      return pathToFileURL(path.resolve(packageDirectory, entry)).href;
    }
    const parent = path.dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  throw new Error(`Step Pack package is not installed from ${cwd}: ${name}.`);
}

export async function loadStepPack(
  specifier: string,
  cwd = process.cwd(),
): Promise<StepPack> {
  const normalized = specifier.trim();
  if (!normalized) throw new Error("--pack requires a package or module path.");
  const moduleSpecifier = isPathSpecifier(normalized)
    ? pathToFileURL(path.resolve(cwd, normalized)).href
    : packageModuleUrl(normalized, cwd);
  const loaded = await import(moduleSpecifier) as { default?: unknown };
  if (loaded.default === undefined) {
    throw new Error(`Step Pack module ${normalized} must have a default export.`);
  }
  return parseStepPack(loaded.default);
}

export async function loadStepPacks(
  specifiers: readonly string[],
  cwd = process.cwd(),
) {
  if (specifiers.length === 0) throw new Error("At least one --pack is required.");
  return Promise.all(specifiers.map((specifier) => loadStepPack(specifier, cwd)));
}

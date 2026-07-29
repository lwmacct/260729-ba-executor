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

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function packageRootExport(value: unknown) {
  const rootExport = isRecord(value) && "." in value ? value["."] : value;
  if (typeof rootExport === "string") return rootExport;
  if (!isRecord(rootExport)) return undefined;
  if (typeof rootExport.import === "string") return rootExport.import;
  return typeof rootExport.default === "string" ? rootExport.default : undefined;
}

function packageDirectoryModuleUrl(packageDirectory: string, label: string) {
  const directory = path.resolve(packageDirectory);
  if (!fs.existsSync(directory) || !fs.statSync(directory).isDirectory()) {
    throw new Error(`Step Pack path must be a package directory: ${label}.`);
  }
  const manifestPath = path.join(directory, "package.json");
  if (!fs.existsSync(manifestPath)) {
    throw new Error(`Step Pack directory must contain package.json: ${label}.`);
  }
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as {
    exports?: unknown;
  };
  const entry = packageRootExport(manifest.exports);
  if (!entry || !entry.startsWith("./")) {
    throw new Error(
      `Step Pack package must define a relative root exports import: ${label}.`,
    );
  }
  const entryPath = path.resolve(directory, entry);
  const relativeEntry = path.relative(directory, entryPath);
  if (relativeEntry.startsWith("..") || path.isAbsolute(relativeEntry)) {
    throw new Error(`Step Pack root export must stay inside its package: ${label}.`);
  }
  if (!fs.existsSync(entryPath) || !fs.statSync(entryPath).isFile()) {
    throw new Error(`Step Pack root export does not exist; build the package first: ${label}.`);
  }
  return pathToFileURL(entryPath).href;
}

function installedPackageModuleUrl(specifier: string, cwd: string) {
  const name = packageName(specifier);
  let directory = path.resolve(cwd);
  while (true) {
    const packageDirectory = path.join(directory, "node_modules", name);
    if (fs.existsSync(path.join(packageDirectory, "package.json"))) {
      return packageDirectoryModuleUrl(packageDirectory, name);
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
  if (!normalized) throw new Error("--pack requires a package name or directory.");
  const moduleSpecifier = isPathSpecifier(normalized)
    ? packageDirectoryModuleUrl(path.resolve(cwd, normalized), normalized)
    : installedPackageModuleUrl(normalized, cwd);
  const loaded = await import(moduleSpecifier) as { default?: unknown };
  if (loaded.default === undefined) {
    throw new Error(`Step Pack package ${normalized} must have a default export.`);
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

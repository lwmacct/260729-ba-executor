import type { StepPack } from "@lwmacct/260729-ba-framework/pack";
import {
  createStepExecutor,
  createStepRegistry,
} from "@lwmacct/260729-ba-framework/executor";
import { createStepCatalogManifest } from "@lwmacct/260729-ba-framework/manifest";

export function createCatalogExecutor(packs: readonly StepPack[]) {
  const registry = createStepRegistry(packs.flatMap((pack) => pack.steps));
  const execute = createStepExecutor({ registry });
  const manifest = createStepCatalogManifest(packs, {
    capabilities: ["steps.execute"],
  });
  return { execute, manifest, packs, registry };
}

export type CatalogExecutor = ReturnType<typeof createCatalogExecutor>;

import type { JsonValue } from "@lwmacct/260729-ba-context-baton";
import type { WorkflowBundle } from "@lwmacct/260729-ba-framework/bundle";
import {
  createStepExecutor,
  createStepRegistry,
} from "@lwmacct/260729-ba-framework/executor";
import { createWorkflowExecutorManifest } from "@lwmacct/260729-ba-framework/manifest";

export function createBundleExecutor(bundle: WorkflowBundle) {
  const registry = createStepRegistry(bundle.steps);
  const execute = createStepExecutor({
    registry,
    createRuntimeContext(resources: Record<string, JsonValue>) {
      return { resources };
    },
  });
  const manifest = createWorkflowExecutorManifest(registry.definitions, {
    workflowId: bundle.id,
    capabilities: ["browser.check", "steps.execute"],
  });
  return { bundle, execute, manifest, registry };
}

export type BundleExecutor = ReturnType<typeof createBundleExecutor>;

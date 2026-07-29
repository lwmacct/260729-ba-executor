#!/usr/bin/env node
import { runCli } from "./cli.js";

if (process.env.BA_EXECUTOR_DEV_CHILD === "1") {
  process.once("disconnect", () => process.exit(0));
}

runCli().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});

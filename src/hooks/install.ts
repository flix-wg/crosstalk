import { harnessAdapter } from "../client/index.js";
export function installHarness(cwd: string, harness: string, local = false): string {
  return harnessAdapter(harness).install(cwd, local);
}

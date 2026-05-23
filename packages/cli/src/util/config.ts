// CLI-side config loader. Reads the daemon's canonical config file and
// validates with the shared ConfigSchema. No permission check (the daemon
// owns that on Unix); the CLI is read-only for config except in
// `token rotate` (T-0017), which delegates to the daemon's IPC handler.

import { readFile } from "node:fs/promises";
import { ConfigSchema, type Config } from "@claude-bridge/shared";

export async function loadCliConfig(path: string): Promise<Config> {
  const raw = await readFile(path, "utf8");
  const parsed: unknown = JSON.parse(raw);
  return ConfigSchema.parse(parsed);
}

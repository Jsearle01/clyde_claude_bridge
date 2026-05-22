// First-run config generation. Writes a default Config to disk with mode 0600
// on Unix; refuses to overwrite an existing file so callers (T-0015 CLI start)
// can distinguish "first run" from "already initialized."

import { mkdir, writeFile, chmod, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { type Config } from "@claude-bridge/shared";
import { generateToken } from "./token.js";

export class ConfigAlreadyExistsError extends Error {
  constructor(public readonly path: string) {
    super(`Config file already exists at ${path}`);
    this.name = "ConfigAlreadyExistsError";
  }
}

function isErrnoCode(err: unknown, code: string): boolean {
  return (
    err instanceof Error &&
    (err as NodeJS.ErrnoException).code === code
  );
}

export async function initConfig(path: string): Promise<Config> {
  let exists = true;
  try {
    await stat(path);
  } catch (err) {
    if (isErrnoCode(err, "ENOENT")) {
      exists = false;
    } else {
      throw err;
    }
  }
  if (exists) throw new ConfigAlreadyExistsError(path);

  const parentDir = dirname(path);
  await mkdir(parentDir, { recursive: true, mode: 0o700 });

  const config: Config = {
    version: 1,
    daemon: {
      bind_host: "127.0.0.1",
      bind_port: 7423,
      ipc_socket: join(parentDir, "daemon.sock"),
    },
    auth: { token: generateToken() },
    tunnel: {
      provider: "cloudflared",
      binary: "cloudflared",
      args_extra: [],
    },
    audit: {
      path: join(parentDir, "audit.jsonl"),
      retention_days: 30,
    },
    log: {
      path: join(parentDir, "daemon.log"),
      level: "info",
    },
  };

  await writeFile(path, JSON.stringify(config, null, 2), { mode: 0o600 });
  if (process.platform !== "win32") {
    // Unconditional post-condition: 0600. writeFile's mode option is honored
    // only on file creation; an explicit chmod removes any dependence on
    // file-existence state.
    await chmod(path, 0o600);
  }

  return config;
}

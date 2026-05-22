// Config file loader. Parse site for ConfigSchema (CC-6 trust boundary).
// Enforces AC-9 from 01-p0-bus.md: on Unix, refuse to load a config file with
// permissions looser than 0600.

import { stat, readFile } from "node:fs/promises";
import { ConfigSchema, type Config } from "@claude-bridge/shared";
import { expandTilde } from "./paths.js";

export class ConfigNotFoundError extends Error {
  constructor(public readonly path: string) {
    super(`Config file not found at ${path}`);
    this.name = "ConfigNotFoundError";
  }
}

export class ConfigPermissionError extends Error {
  constructor(
    public readonly path: string,
    public readonly mode: number,
  ) {
    const octal = (mode & 0o777).toString(8).padStart(3, "0");
    super(
      `Config file at ${path} has loose permissions (0${octal}); must be 0600`,
    );
    this.name = "ConfigPermissionError";
  }
}

export class ConfigValidationError extends Error {
  constructor(
    public readonly path: string,
    public readonly issues: unknown,
  ) {
    super(`Config file at ${path} failed validation`);
    this.name = "ConfigValidationError";
  }
}

function isErrnoCode(err: unknown, code: string): boolean {
  return (
    err instanceof Error &&
    (err as NodeJS.ErrnoException).code === code
  );
}

export async function loadConfig(path: string): Promise<Config> {
  let mode: number;
  try {
    const stats = await stat(path);
    mode = stats.mode;
  } catch (err) {
    if (isErrnoCode(err, "ENOENT")) {
      throw new ConfigNotFoundError(path);
    }
    throw err;
  }

  if (process.platform !== "win32" && (mode & 0o077) !== 0) {
    throw new ConfigPermissionError(path, mode);
  }

  const raw = await readFile(path, "utf8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    // SyntaxError from malformed JSON becomes a validation failure — callers
    // shouldn't have to distinguish "syntactically invalid" from
    // "structurally invalid" config.
    throw new ConfigValidationError(
      path,
      err instanceof Error ? err.message : String(err),
    );
  }

  const result = ConfigSchema.safeParse(parsed);
  if (!result.success) {
    throw new ConfigValidationError(path, result.error.format());
  }

  const config = result.data;
  return {
    ...config,
    daemon: {
      ...config.daemon,
      ipc_socket: expandTilde(config.daemon.ipc_socket),
    },
    audit: { ...config.audit, path: expandTilde(config.audit.path) },
    log: { ...config.log, path: expandTilde(config.log.path) },
  };
}

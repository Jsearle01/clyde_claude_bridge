import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  writePidFile,
  checkStalePid,
  removePidFile,
} from "../src/pidfile.js";

describe("pidfile", () => {
  let tempDir: string;
  let pidPath: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "claude-bridge-pidfile-"));
    pidPath = join(tempDir, "daemon.pid");
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it("writes the current process PID", async () => {
    await writePidFile(pidPath);
    const content = await readFile(pidPath, "utf8");
    expect(Number.parseInt(content.trim(), 10)).toBe(process.pid);
  });

  it("checkStalePid returns 'alive' for the current process", async () => {
    await writePidFile(pidPath);
    expect(await checkStalePid(pidPath)).toBe("alive");
  });

  it("checkStalePid returns 'absent' for a missing file", async () => {
    expect(await checkStalePid(pidPath)).toBe("absent");
  });

  it("checkStalePid returns 'stale' for a dead PID", async () => {
    // PID 99999 is unlikely to exist on a normal test host. process.kill
    // with signal 0 raises ESRCH → "stale".
    await writeFile(pidPath, "99999", { mode: 0o600 });
    expect(await checkStalePid(pidPath)).toBe("stale");
  });

  it("checkStalePid returns 'stale' for a malformed file", async () => {
    await writeFile(pidPath, "not-a-pid", { mode: 0o600 });
    expect(await checkStalePid(pidPath)).toBe("stale");
  });

  it("removePidFile tolerates ENOENT", async () => {
    await expect(removePidFile(pidPath)).resolves.toBeUndefined();
  });

  it("removePidFile deletes an existing file", async () => {
    await writePidFile(pidPath);
    await removePidFile(pidPath);
    expect(await checkStalePid(pidPath)).toBe("absent");
  });
});

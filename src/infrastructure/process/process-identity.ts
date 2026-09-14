import crypto from "node:crypto";
import fs from "node:fs";
import { spawnSync } from "node:child_process";

import { OrchestratorError } from "../../shared/errors.js";

function hash(value: string): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function windowsIdentity(pid: number): string | undefined {
  const script = [
    `$process = Get-Process -Id ${String(pid)} -ErrorAction SilentlyContinue`,
    "if ($null -ne $process) { try { $created = $process.StartTime.ToUniversalTime().Ticks; $executable = $process.Path; [Console]::Out.Write(('{0}|{1}|{2}' -f $process.Id, $created, $executable)); exit 0 } catch {} }",
    `$item = Get-CimInstance Win32_Process -Filter "ProcessId = ${String(pid)}" -ErrorAction SilentlyContinue`,
    "if ($null -eq $item) { exit 3 }",
    "$created = $item.CreationDate.ToUniversalTime().Ticks",
    "[Console]::Out.Write(('{0}|{1}|{2}' -f $item.ProcessId, $created, $item.ExecutablePath))",
  ].join("; ");
  const result = spawnSync(
    "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
    ["-NoProfile", "-NonInteractive", "-Command", script],
    { encoding: "utf8", windowsHide: true, timeout: 5_000, maxBuffer: 64_000 },
  );
  const value = result.status === 0 ? result.stdout.trim() : "";
  return value ? hash(value) : undefined;
}

function linuxIdentity(pid: number): string | undefined {
  try {
    const stat = fs.readFileSync(`/proc/${String(pid)}/stat`, "utf8");
    const commandEnd = stat.lastIndexOf(")");
    if (commandEnd < 0) {
      return undefined;
    }
    const fields = stat
      .slice(commandEnd + 1)
      .trim()
      .split(/\s+/);
    const startTime = fields[19];
    if (!startTime) {
      return undefined;
    }
    const bootId = fs.readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
    const executable = fs.readlinkSync(`/proc/${String(pid)}/exe`);
    return hash(`${bootId}|${String(pid)}|${startTime}|${executable}`);
  } catch {
    return undefined;
  }
}

function portableIdentity(pid: number): string | undefined {
  const result = spawnSync("ps", ["-p", String(pid), "-o", "lstart=", "-o", "comm="], {
    encoding: "utf8",
    windowsHide: true,
    timeout: 5_000,
    maxBuffer: 64_000,
  });
  const value = result.status === 0 ? result.stdout.trim() : "";
  return value ? hash(`${String(pid)}|${value}`) : undefined;
}

export function processIdentity(pid: number): string | undefined {
  if (!Number.isInteger(pid) || pid <= 0) {
    throw new OrchestratorError("INVALID_PROCESS_ID", "Process ID is invalid", { pid });
  }
  if (process.platform === "win32") {
    return windowsIdentity(pid);
  }
  if (process.platform === "linux") {
    return linuxIdentity(pid);
  }
  return portableIdentity(pid);
}

export function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export async function waitForProcessIdentity(
  pid: number,
  timeoutMs = 5_000,
): Promise<string | undefined> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() <= deadline) {
    const identity = processIdentity(pid);
    if (identity) {
      return identity;
    }
    if (!processIsAlive(pid)) {
      return undefined;
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 50));
  }
  return undefined;
}

export async function waitForProcessExit(pid: number, timeoutMs = 5_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (processIsAlive(pid) && Date.now() < deadline) {
    await new Promise<void>((resolve) => setTimeout(resolve, 50));
  }
  return !processIsAlive(pid);
}

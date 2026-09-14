import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

import type { WorkerAdapterId } from "../../configuration/schema.js";
import { OrchestratorError } from "../../shared/errors.js";

function existing(paths: readonly (string | undefined)[]): string | undefined {
  return paths.find((candidate): candidate is string =>
    Boolean(candidate && fs.existsSync(candidate)),
  );
}

export function findExecutable(name: string): string | undefined {
  const result =
    process.platform === "win32"
      ? spawnSync("C:\\Windows\\System32\\where.exe", [name], {
          encoding: "utf8",
          windowsHide: true,
        })
      : spawnSync("which", [name], { encoding: "utf8", windowsHide: true });
  return result.stdout
    .split(/\r?\n/)
    .map((value) => value.trim())
    .find((value) => path.isAbsolute(value) && fs.existsSync(value));
}

export function discoverGit(): string {
  const command = findExecutable(process.platform === "win32" ? "git.exe" : "git");
  if (!command) {
    throw new OrchestratorError("GIT_NOT_FOUND", "Git executable was not found");
  }
  return command;
}

export function discoverCodex(): string {
  const command =
    process.platform === "win32"
      ? existing([
          path.join(process.env.ProgramFiles ?? "C:\\Program Files", "nodejs", "codex.ps1"),
          findExecutable("codex.exe"),
        ])
      : findExecutable("codex");
  if (!command) {
    throw new OrchestratorError("CODEX_NOT_FOUND", "Codex CLI executable was not found");
  }
  return command;
}

export function discoverWorker(adapter: WorkerAdapterId): { command: string; args: string[] } {
  if (process.platform === "win32") {
    const localAppData = process.env.LOCALAPPDATA;
    const programFiles = process.env.ProgramFiles ?? "C:\\Program Files";
    const node = existing([path.join(programFiles, "nodejs", "node.exe"), process.execPath]);
    const command =
      adapter === "cursor"
        ? existing([
            localAppData ? path.join(localAppData, "cursor-agent", "agent.ps1") : undefined,
          ])
        : adapter === "antigravity"
          ? existing([localAppData ? path.join(localAppData, "agy", "bin", "agy.exe") : undefined])
          : node;
    const runtime =
      adapter === "workbuddy"
        ? existing([
            path.join(
              programFiles,
              "WorkBuddy",
              "resources",
              "app.asar.unpacked",
              "cli",
              "bin",
              "codebuddy",
            ),
          ])
        : adapter === "zcode"
          ? existing([path.join(programFiles, "ZCode", "resources", "glm", "zcode.cjs")])
          : undefined;
    if (!command || ((adapter === "workbuddy" || adapter === "zcode") && !runtime)) {
      throw new OrchestratorError("WORKER_NOT_FOUND", `Worker CLI was not found: ${adapter}`);
    }
    return { command, args: runtime ? [runtime] : [] };
  }
  const command = findExecutable(
    adapter === "cursor"
      ? "cursor-agent"
      : adapter === "antigravity"
        ? "agy"
        : adapter === "workbuddy"
          ? "codebuddy"
          : "zcode",
  );
  if (!command) {
    throw new OrchestratorError("WORKER_NOT_FOUND", `Worker CLI was not found: ${adapter}`);
  }
  return { command, args: [] };
}

export function discoverRtkShellPermission(): readonly string[] {
  return findExecutable(process.platform === "win32" ? "rtk.exe" : "rtk") ? ["Shell(rtk:*)"] : [];
}

#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { createInterface } from "node:readline/promises";

import type { WorkerAdapterId } from "../../configuration/schema.js";
import {
  CONFIG_VERSION,
  parseConfig,
  type OrchestratorConfig,
} from "../../configuration/schema.js";
import { ConfigFileRepository } from "../../configuration/file-repository.js";
import { DEFAULT_BUDGETS } from "../../domain/budgets.js";
import { LocalProcessRunner } from "../../infrastructure/process/local-process-runner.js";
import { createControlRuntime } from "../../runtime/control-runtime.js";
import { runtimePaths } from "../../runtime/paths.js";
import { OrchestratorError } from "../../shared/errors.js";
import {
  discoverCodex,
  discoverGit,
  discoverRtkShellPermission,
  discoverWorker,
} from "./discovery.js";

interface ParsedArgs {
  readonly command?: string;
  readonly positionals: readonly string[];
  readonly options: Readonly<Record<string, string | boolean>>;
}

function parseArgs(values: readonly string[]): ParsedArgs {
  const [command, ...rest] = values;
  const positionals: string[] = [];
  const options: Record<string, string | boolean> = {};
  for (let index = 0; index < rest.length; index += 1) {
    const value = rest[index];
    if (!value) {
      continue;
    }
    if (!value.startsWith("--")) {
      positionals.push(value);
      continue;
    }
    const key = value.slice(2);
    const next = rest[index + 1];
    if (!next || next.startsWith("--")) {
      options[key] = true;
    } else {
      options[key] = next;
      index += 1;
    }
  }
  return { ...(command ? { command } : {}), positionals, options };
}

function option(args: ParsedArgs, name: string): string | undefined {
  const value = args.options[name];
  return typeof value === "string" ? value : undefined;
}

async function requiredOption(args: ParsedArgs, name: string, prompt: string): Promise<string> {
  const configured = option(args, name);
  if (configured) {
    return configured;
  }
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new OrchestratorError("CLI_INPUT_REQUIRED", `Missing --${name}`);
  }
  const readline = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = (await readline.question(`${prompt}: `)).trim();
    if (!answer) {
      throw new OrchestratorError("CLI_INPUT_REQUIRED", `Missing --${name}`);
    }
    return answer;
  } finally {
    readline.close();
  }
}

function adapter(value: string): WorkerAdapterId {
  if (!["cursor", "antigravity", "workbuddy", "zcode"].includes(value)) {
    throw new OrchestratorError("INVALID_WORKER_ADAPTER", `Unsupported Worker Adapter: ${value}`);
  }
  return value as WorkerAdapterId;
}

function configuredWorker(
  args: ParsedArgs,
  role: "implementation" | "review",
  adapterId: WorkerAdapterId,
): { command: string; args: string[] } {
  const command = option(args, `${role}-command`);
  if (!command) {
    return discoverWorker(adapterId);
  }
  const absolute = path.resolve(command);
  if (!fs.existsSync(absolute)) {
    throw new OrchestratorError("WORKER_NOT_FOUND", `Worker command does not exist: ${absolute}`);
  }
  const rawArgs = option(args, `${role}-args-json`);
  if (!rawArgs) {
    return { command: absolute, args: [] };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawArgs) as unknown;
  } catch (error) {
    throw new OrchestratorError(
      "INVALID_WORKER_ARGS",
      `${role} args must be a JSON array`,
      undefined,
      {
        cause: error,
      },
    );
  }
  if (!Array.isArray(parsed) || !parsed.every((value) => typeof value === "string")) {
    throw new OrchestratorError("INVALID_WORKER_ARGS", `${role} args must be a JSON string array`);
  }
  return { command: absolute, args: parsed };
}

async function currentBranch(gitCommand: string, repository: string): Promise<string> {
  const result = await new LocalProcessRunner().run(gitCommand, ["branch", "--show-current"], {
    cwd: repository,
    timeoutMs: 30_000,
    maxCaptureBytes: 10_000,
  });
  const branch = result.stdout.trim();
  if (result.exitCode !== 0 || !branch) {
    throw new OrchestratorError(
      "TARGET_BRANCH_UNAVAILABLE",
      "Unable to determine current Git branch",
    );
  }
  return branch;
}

function stableId(value: string): string {
  const normalized = value
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
  return /^[a-z]/.test(normalized) ? normalized : `project-${normalized || "default"}`;
}

function powershell(): string {
  return path.join(
    process.env.SystemRoot ?? "C:\\Windows",
    "System32",
    "WindowsPowerShell",
    "v1.0",
    "powershell.exe",
  );
}

function acceptanceGate(repository: string, gitCommand: string) {
  const windowsScript = path.join(repository, "acceptance-ci.ps1");
  const posixScript = path.join(repository, "acceptance-ci.sh");
  if (process.platform === "win32" && fs.existsSync(windowsScript)) {
    return {
      id: "acceptance",
      command: powershell(),
      args: [
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        "acceptance-ci.ps1",
      ],
      dependsOn: ["diff-check"],
      timeoutMinutes: 180,
    };
  }
  if (process.platform !== "win32" && fs.existsSync(posixScript)) {
    return {
      id: "acceptance",
      command: "/bin/bash",
      args: ["acceptance-ci.sh"],
      dependsOn: ["diff-check"],
      timeoutMinutes: 180,
    };
  }
  return {
    id: "acceptance",
    command: gitCommand,
    args: ["diff", "--check", "HEAD"],
    dependsOn: ["diff-check"],
    timeoutMinutes: 5,
  };
}

async function initialize(args: ParsedArgs): Promise<void> {
  const repository = path.resolve(args.positionals[0] ?? "");
  if (!args.positionals[0] || !fs.existsSync(repository)) {
    throw new OrchestratorError("REPOSITORY_REQUIRED", "init requires an existing repository path");
  }
  const paths = runtimePaths(option(args, "home"));
  const configRepository = new ConfigFileRepository(paths.configFile);
  configRepository.requireAbsent();
  const gitCommand = discoverGit();
  const implementationAdapter = adapter(option(args, "implementation-adapter") ?? "cursor");
  const reviewAdapter = adapter(option(args, "review-adapter") ?? "antigravity");
  if (implementationAdapter === reviewAdapter) {
    throw new OrchestratorError(
      "INDEPENDENT_REVIEWER_REQUIRED",
      "Implementation and review Adapters must differ",
    );
  }
  const implementation = configuredWorker(args, "implementation", implementationAdapter);
  const review = configuredWorker(args, "review", reviewAdapter);
  const implementationModel = await requiredOption(
    args,
    "implementation-model",
    "Implementation model ID",
  );
  const reviewModel = await requiredOption(args, "review-model", "Review model ID");
  const projectId = stableId(option(args, "project-id") ?? path.basename(repository));
  const targetBranch =
    option(args, "target-branch") ?? (await currentBranch(gitCommand, repository));
  const worktreeRoot = path.resolve(option(args, "worktree-root") ?? `${repository}-worktrees`);
  const route = { implementation: "implementation", review: "review" };
  const config: OrchestratorConfig = parseConfig({
    version: CONFIG_VERSION,
    defaultProject: projectId,
    runtime: { gitCommand },
    workers: {
      implementation: {
        adapter: implementationAdapter,
        ...implementation,
        model: implementationModel,
        shellAllow: implementationAdapter === "cursor" ? discoverRtkShellPermission() : [],
      },
      review: {
        adapter: reviewAdapter,
        ...review,
        model: reviewModel,
        shellAllow: [],
      },
    },
    routing: { normal: route, high: route, critical: route },
    projects: {
      [projectId]: {
        repository,
        targetBranch,
        worktreeRoot,
        instructionFiles: ["AGENTS.md", "README.md"].filter((file) =>
          fs.existsSync(path.join(repository, file)),
        ),
        gates: {
          affected: [
            {
              id: "diff-check",
              command: gitCommand,
              args: ["diff", "--check", "HEAD"],
              dependsOn: [],
              timeoutMinutes: 5,
            },
          ],
          acceptance: acceptanceGate(repository, gitCommand),
        },
      },
    },
    budgets: DEFAULT_BUDGETS,
    logging: { maxBytes: 2_000_000, retentionDays: 14 },
  });
  configRepository.write(config);
  process.stdout.write(
    `${JSON.stringify({ ok: true, configFile: paths.configFile, projectId }, null, 2)}\n`,
  );
}

async function doctor(args: ParsedArgs): Promise<void> {
  const paths = runtimePaths(option(args, "home"));
  const runnerFile = path.resolve(import.meta.dirname, "../runner/main.js");
  const runtime = createControlRuntime(runnerFile, paths.home);
  try {
    const result = await runtime.doctor.run(option(args, "project-id"));
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    if (!result.ok) {
      process.exitCode = 1;
    }
  } finally {
    runtime.close();
  }
}

async function codexMcp(args: ParsedArgs, action: "install" | "uninstall"): Promise<void> {
  const codex = discoverCodex();
  const paths = runtimePaths(option(args, "home"));
  const runner = new LocalProcessRunner();
  const name = "dev-agent-orchestrator";
  if (action === "install") {
    const existing = await runner.run(codex, ["mcp", "get", name], {
      cwd: process.cwd(),
      timeoutMs: 30_000,
      maxCaptureBytes: 20_000,
    });
    if (existing.exitCode === 0) {
      const removed = await runner.run(codex, ["mcp", "remove", name], {
        cwd: process.cwd(),
        timeoutMs: 30_000,
        maxCaptureBytes: 20_000,
      });
      if (removed.exitCode !== 0) {
        throw new OrchestratorError(
          "MCP_REMOVE_FAILED",
          "Unable to replace existing MCP registration",
        );
      }
    }
    const serverFile = path.resolve(import.meta.dirname, "../mcp/server.js");
    const installed = await runner.run(
      codex,
      [
        "mcp",
        "add",
        name,
        "--env",
        `DEV_AGENT_ORCHESTRATOR_HOME=${paths.home}`,
        "--",
        process.execPath,
        serverFile,
      ],
      { cwd: process.cwd(), timeoutMs: 30_000, maxCaptureBytes: 20_000 },
    );
    if (installed.exitCode !== 0) {
      throw new OrchestratorError("MCP_INSTALL_FAILED", "Codex MCP installation failed");
    }
  } else {
    const removed = await runner.run(codex, ["mcp", "remove", name], {
      cwd: process.cwd(),
      timeoutMs: 30_000,
      maxCaptureBytes: 20_000,
    });
    if (removed.exitCode !== 0) {
      throw new OrchestratorError("MCP_REMOVE_FAILED", "Codex MCP removal failed");
    }
  }
  process.stdout.write(`${JSON.stringify({ ok: true, action, restartRequired: true }, null, 2)}\n`);
}

function usage(): string {
  return [
    "Usage:",
    "  dev-agent-orchestrator init <repository> --implementation-model <id> --review-model <id>",
    "  dev-agent-orchestrator doctor [--project-id <id>]",
    "  dev-agent-orchestrator mcp install",
    "  dev-agent-orchestrator mcp uninstall",
  ].join("\n");
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.command === "init") {
    await initialize(args);
    return;
  }
  if (args.command === "doctor") {
    await doctor(args);
    return;
  }
  if (args.command === "mcp" && args.positionals[0] === "install") {
    await codexMcp(args, "install");
    return;
  }
  if (args.command === "mcp" && args.positionals[0] === "uninstall") {
    await codexMcp(args, "uninstall");
    return;
  }
  process.stdout.write(`${usage()}\n`);
  process.exitCode = 1;
}

try {
  await main();
} catch (error) {
  process.stderr.write(
    `${JSON.stringify({
      error: {
        code: error instanceof OrchestratorError ? error.code : "CLI_FAILED",
        message: error instanceof Error ? error.message : String(error),
      },
    })}\n`,
  );
  process.exitCode = 1;
}

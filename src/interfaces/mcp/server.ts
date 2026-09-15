import fs from "node:fs";
import path from "node:path";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import type { TaskDecision } from "../../application/control-service.js";
import { createControlRuntime } from "../../runtime/control-runtime.js";
import { OrchestratorError } from "../../shared/errors.js";

const packageMetadata = JSON.parse(
  fs.readFileSync(path.resolve(import.meta.dirname, "../../../../package.json"), "utf8"),
) as { readonly version?: unknown };
if (typeof packageMetadata.version !== "string") {
  throw new OrchestratorError("PACKAGE_VERSION_INVALID", "Package version is invalid");
}
const PACKAGE_VERSION = packageMetadata.version;

function textResult(value: unknown, isError = false) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }],
    isError,
  };
}

async function guarded(action: () => unknown) {
  try {
    return textResult(await action());
  } catch (error) {
    return textResult(
      {
        error: {
          code: error instanceof OrchestratorError ? error.code : "UNEXPECTED_ERROR",
          message: error instanceof Error ? error.message : String(error),
          ...(error instanceof OrchestratorError && error.details
            ? { details: error.details }
            : {}),
        },
      },
      true,
    );
  }
}

function requiredString(value: string | undefined, field: string): string {
  if (!value?.trim()) {
    throw new OrchestratorError("DECISION_INPUT_REQUIRED", `Decision requires ${field}`);
  }
  return value;
}

export function startReconcileMonitor(
  reconcile: () => Promise<unknown>,
  reportFailure: (error: unknown) => void,
  intervalMs = 30_000,
): { readonly stop: () => Promise<void> } {
  if (!Number.isInteger(intervalMs) || intervalMs < 1) {
    throw new OrchestratorError("INVALID_RECONCILE_INTERVAL", "Reconcile interval is invalid");
  }
  let inFlight: Promise<void> | undefined;
  let stopped = false;
  const tick = (): void => {
    if (stopped || inFlight) {
      return;
    }
    inFlight = (async () => {
      try {
        await reconcile();
      } catch (error) {
        try {
          reportFailure(error);
        } catch {
          process.stderr.write("RECONCILE_MONITOR_REPORT_FAILED\n");
          process.exitCode = 1;
        }
      } finally {
        inFlight = undefined;
      }
    })();
  };
  const timer = setInterval(tick, intervalMs);
  timer.unref();
  return {
    stop: async () => {
      stopped = true;
      clearInterval(timer);
      await inFlight;
    },
  };
}

export function createMcpServer(home?: string): {
  readonly server: McpServer;
  readonly reconcile: () => Promise<{ readonly blockedTasks: readonly string[] }>;
  readonly startMonitor: (intervalMs?: number) => { readonly stop: () => Promise<void> };
  readonly close: () => void;
} {
  const runnerFile = path.resolve(import.meta.dirname, "../runner/main.js");
  const runtime = createControlRuntime(runnerFile, home);
  const server = new McpServer(
    { name: "dev-agent-orchestrator", version: PACKAGE_VERSION },
    {
      instructions:
        "Use doctor before the first Task. Start one stable Task per objective, observe until a control decision is required, inspect the Candidate fingerprint, then decide. The orchestrator owns Worker execution, Gates, independent review, recovery, and delivery ordering.",
    },
  );

  server.registerTool(
    "orchestrator_doctor",
    {
      description: "Validate configuration, Project, Gates, Worker CLI contracts, and models.",
      inputSchema: { projectId: z.string().optional() },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ projectId }) => await guarded(async () => await runtime.doctor.run(projectId)),
  );

  server.registerTool(
    "orchestrator_start",
    {
      description: "Create one stable Task and start its internal workflow.",
      inputSchema: {
        projectId: z.string().optional(),
        objective: z.string().min(8).max(100_000),
        risk: z.enum(["normal", "high", "critical"]),
        initialScope: z.array(z.string().min(1)).min(1).max(500),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    async (input) =>
      await guarded(
        async () =>
          await runtime.control.start({
            objective: input.objective,
            risk: input.risk,
            initialScope: input.initialScope,
            ...(input.projectId ? { projectId: input.projectId } : {}),
          }),
      ),
  );

  server.registerTool(
    "orchestrator_observe",
    {
      description: "Read a compact Task state or wait for its optimistic revision to change.",
      inputSchema: {
        taskId: z.string().min(8),
        afterRevision: z.number().int().positive().optional(),
        timeoutMs: z.number().int().min(0).max(60_000).default(0),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ taskId, afterRevision, timeoutMs }) =>
      await guarded(async () => await runtime.control.observe(taskId, afterRevision, timeoutMs)),
  );

  server.registerTool(
    "orchestrator_get_candidate",
    {
      description: "Read the Candidate manifest, bounded patch, or one bounded file patch.",
      inputSchema: {
        taskId: z.string().min(8),
        mode: z.enum(["manifest", "patch", "file"]).default("manifest"),
        maxChars: z.number().int().min(1_000).max(1_000_000).default(100_000),
        file: z.string().optional(),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ taskId, mode, maxChars, file }) =>
      await guarded(async () => {
        if (mode === "manifest") {
          return await runtime.control.candidate(taskId, mode, maxChars);
        }
        if (mode === "patch") {
          return await runtime.control.candidate(taskId, mode, maxChars);
        }
        return await runtime.control.candidate(
          taskId,
          mode,
          maxChars,
          requiredString(file, "file"),
        );
      }),
  );

  server.registerTool(
    "orchestrator_decide",
    {
      description:
        "Apply one optimistic scope, rework, Candidate, delivery, or cancellation decision.",
      inputSchema: {
        action: z.enum([
          "approve_scope",
          "request_rework",
          "approve_candidate",
          "approve_delivery",
          "cancel",
        ]),
        taskId: z.string().min(8),
        expectedRevision: z.number().int().positive(),
        expectedFingerprint: z
          .string()
          .regex(/^[a-f0-9]{64}$/i)
          .optional(),
        paths: z.array(z.string().min(1)).min(1).max(500).optional(),
        reason: z.string().min(3).max(20_000).optional(),
        summary: z.string().min(3).max(20_000).optional(),
        commitMessage: z.string().min(3).max(500).optional(),
        push: z.boolean().default(false),
        idempotencyKey: z.string().min(8).max(128).optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    async (input) =>
      await guarded(async () => {
        const base = { taskId: input.taskId, expectedRevision: input.expectedRevision };
        let decision: TaskDecision;
        switch (input.action) {
          case "approve_scope":
            if (!input.paths) {
              throw new OrchestratorError(
                "DECISION_INPUT_REQUIRED",
                "Scope decision requires paths",
              );
            }
            decision = {
              ...base,
              action: input.action,
              paths: input.paths,
              expectedFingerprint: requiredString(input.expectedFingerprint, "expectedFingerprint"),
              reason: requiredString(input.reason, "reason"),
            };
            break;
          case "request_rework":
          case "cancel":
            decision = {
              ...base,
              action: input.action,
              reason: requiredString(input.reason, "reason"),
            };
            break;
          case "approve_candidate":
            decision = {
              ...base,
              action: input.action,
              expectedFingerprint: requiredString(input.expectedFingerprint, "expectedFingerprint"),
              summary: requiredString(input.summary, "summary"),
            };
            break;
          case "approve_delivery":
            decision = {
              ...base,
              action: input.action,
              expectedFingerprint: requiredString(input.expectedFingerprint, "expectedFingerprint"),
              commitMessage: requiredString(input.commitMessage, "commitMessage"),
              idempotencyKey: requiredString(input.idempotencyKey, "idempotencyKey"),
              push: input.push,
            };
            break;
        }
        return await runtime.control.decide(decision);
      }),
  );

  return {
    server,
    reconcile: async () => await runtime.control.reconcile(),
    startMonitor: (intervalMs) =>
      startReconcileMonitor(
        async () => await runtime.control.reconcile(),
        (error) =>
          runtime.components.logger.write({
            level: "error",
            event: "error",
            operation: "reconcile",
            errorCode: error instanceof OrchestratorError ? error.code : "RECONCILE_FAILED",
            outcome: "fail",
          }),
        intervalMs,
      ),
    close: runtime.close,
  };
}

async function main(): Promise<void> {
  const runtime = createMcpServer();
  await runtime.reconcile();
  await runtime.server.connect(new StdioServerTransport());
  const monitor = runtime.startMonitor();
  process.once("exit", () => {
    void monitor.stop();
    runtime.close();
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)) {
  await main();
}

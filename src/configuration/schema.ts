import { z } from "zod";

import type { ExecutionBudget } from "../domain/types.js";

export const CONFIG_VERSION = "1.0.0" as const;
export const WORKER_ADAPTERS = ["cursor", "antigravity", "workbuddy", "zcode"] as const;

const StableIdSchema = z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/);
const AbsolutePathSchema = z
  .string()
  .min(1)
  .refine((value) => /^(?:[a-z]:[\\/]|\/)/i.test(value), {
    message: "Path must be absolute",
  });
const CommandSchema = z
  .object({
    command: AbsolutePathSchema,
    args: z.array(z.string()).default([]),
  })
  .strict();
const WorkerSchema = CommandSchema.extend({
  adapter: z.enum(WORKER_ADAPTERS),
  model: z.string().min(1),
  reasoningEffort: z.string().min(1).optional(),
  provider: z.string().min(1).optional(),
  shellAllow: z
    .array(z.string().regex(/^Shell\([^\r\n]{1,200}\)$/))
    .max(100)
    .default([]),
}).strict();
const GateSchema = CommandSchema.extend({
  id: StableIdSchema,
  cwd: z.string().min(1).optional(),
  paths: z.array(z.string().min(1)).min(1).optional(),
  dependsOn: z.array(StableIdSchema).default([]),
  timeoutMinutes: z.number().int().min(1).max(360),
}).strict();
const BudgetSchema = z
  .object({
    maxWallClockMinutes: z.number().int().positive(),
    maxAttempts: z.number().int().min(1).max(10),
    maxWorkerRuns: z.number().int().min(1).max(10),
    maxReviewerRuns: z.number().int().min(1).max(10),
    maxToolEvents: z.number().int().min(1).max(100_000),
    maxCapturedBytes: z.number().int().min(1_000).max(100_000_000),
    maxNoCandidateChangeMinutes: z.number().int().min(1).max(120),
    maxChangedFiles: z.number().int().min(1).max(10_000),
    maxChangedLines: z.number().int().min(1).max(1_000_000),
  })
  .strict();
const RouteSchema = z
  .object({ implementation: StableIdSchema, review: StableIdSchema })
  .strict()
  .refine((route) => route.implementation !== route.review, {
    message: "Implementation and review workers must be different",
  });
const ProjectSchema = z
  .object({
    repository: AbsolutePathSchema,
    targetBranch: z.string().min(1).max(255),
    worktreeRoot: AbsolutePathSchema,
    instructionFiles: z.array(z.string().min(1)).default([]),
    adapterProjectIds: z.partialRecord(z.enum(WORKER_ADAPTERS), z.string().min(1)).optional(),
    gates: z
      .object({
        affected: z.array(GateSchema).min(1),
        acceptance: GateSchema,
      })
      .strict(),
  })
  .strict();

function gateGraphHasCycle(
  gates: readonly { readonly id: string; readonly dependsOn: readonly string[] }[],
): boolean {
  const graph = new Map(gates.map((gate) => [gate.id, gate.dependsOn]));
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (gateId: string): boolean => {
    if (visiting.has(gateId)) {
      return true;
    }
    if (visited.has(gateId)) {
      return false;
    }
    visiting.add(gateId);
    for (const dependency of graph.get(gateId) ?? []) {
      if (visit(dependency)) {
        return true;
      }
    }
    visiting.delete(gateId);
    visited.add(gateId);
    return false;
  };
  return gates.some((gate) => visit(gate.id));
}

export const OrchestratorConfigSchema = z
  .object({
    version: z.literal(CONFIG_VERSION),
    defaultProject: StableIdSchema,
    runtime: z.object({ gitCommand: AbsolutePathSchema }).strict(),
    workers: z.record(StableIdSchema, WorkerSchema),
    routing: z
      .object({
        normal: RouteSchema,
        high: RouteSchema,
        critical: RouteSchema,
      })
      .strict(),
    projects: z.record(StableIdSchema, ProjectSchema),
    budgets: z
      .object({ normal: BudgetSchema, high: BudgetSchema, critical: BudgetSchema })
      .strict(),
    logging: z
      .object({
        maxBytes: z.number().int().min(64_000).max(20_000_000),
        retentionDays: z.number().int().min(1).max(90),
      })
      .strict(),
  })
  .strict()
  .superRefine((config, context) => {
    if (!(config.defaultProject in config.projects)) {
      context.addIssue({
        code: "custom",
        path: ["defaultProject"],
        message: "Default Project is not registered",
      });
    }
    for (const [risk, route] of Object.entries(config.routing)) {
      for (const [role, workerId] of Object.entries(route)) {
        if (!(workerId in config.workers)) {
          context.addIssue({
            code: "custom",
            path: ["routing", risk, role],
            message: "Route references an unknown Worker",
          });
        }
      }
    }
    for (const [projectId, project] of Object.entries(config.projects)) {
      const gates = [...project.gates.affected, project.gates.acceptance];
      const ids = new Set(gates.map((gate) => gate.id));
      const affectedIds = new Set(project.gates.affected.map((gate) => gate.id));
      if (ids.size !== gates.length) {
        context.addIssue({
          code: "custom",
          path: ["projects", projectId, "gates"],
          message: "Gate IDs must be unique",
        });
      }
      for (const gate of gates) {
        for (const dependency of gate.dependsOn) {
          if (!ids.has(dependency) || dependency === gate.id) {
            context.addIssue({
              code: "custom",
              path: ["projects", projectId, "gates", gate.id, "dependsOn"],
              message: "Gate dependency is invalid",
            });
          }
        }
      }
      for (const gate of project.gates.affected) {
        if (gate.dependsOn.some((dependency) => !affectedIds.has(dependency))) {
          context.addIssue({
            code: "custom",
            path: ["projects", projectId, "gates", gate.id, "dependsOn"],
            message: "Affected Gates may depend only on other affected Gates",
          });
        }
      }
      if (gateGraphHasCycle(gates)) {
        context.addIssue({
          code: "custom",
          path: ["projects", projectId, "gates"],
          message: "Gate dependencies must form an acyclic graph",
        });
      }
    }
  });

export type WorkerAdapterId = (typeof WORKER_ADAPTERS)[number];
export type OrchestratorConfig = z.infer<typeof OrchestratorConfigSchema>;
export type WorkerProfile = OrchestratorConfig["workers"][string];
export type ProjectProfile = OrchestratorConfig["projects"][string];
export type GateDefinition = ProjectProfile["gates"]["affected"][number];

export function parseConfig(value: unknown): OrchestratorConfig {
  return OrchestratorConfigSchema.parse(value);
}

export function budgetFor(
  config: OrchestratorConfig,
  risk: keyof OrchestratorConfig["budgets"],
): ExecutionBudget {
  return config.budgets[risk];
}

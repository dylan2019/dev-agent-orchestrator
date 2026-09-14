import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { ConfigFileRepository } from "../../src/configuration/file-repository.js";
import {
  CONFIG_VERSION,
  parseConfig,
  type OrchestratorConfig,
} from "../../src/configuration/schema.js";
import { DEFAULT_BUDGETS } from "../../src/domain/budgets.js";

function config(root: string): OrchestratorConfig {
  return {
    version: CONFIG_VERSION,
    defaultProject: "example",
    workers: {
      implementation: {
        adapter: "cursor",
        command: process.execPath,
        args: [],
        model: "implementation-model",
      },
      review: {
        adapter: "antigravity",
        command: process.execPath,
        args: [],
        model: "review-model",
      },
    },
    routing: {
      normal: { implementation: "implementation", review: "review" },
      high: { implementation: "implementation", review: "review" },
      critical: { implementation: "implementation", review: "review" },
    },
    projects: {
      example: {
        repository: path.join(root, "repository"),
        targetBranch: "main",
        worktreeRoot: path.join(root, "worktrees"),
        instructionFiles: ["AGENTS.md"],
        gates: {
          affected: [
            {
              id: "unit",
              command: process.execPath,
              args: ["--test"],
              dependsOn: [],
              timeoutMinutes: 10,
            },
          ],
          acceptance: {
            id: "acceptance",
            command: process.execPath,
            args: ["--test"],
            dependsOn: ["unit"],
            timeoutMinutes: 30,
          },
        },
      },
    },
    budgets: DEFAULT_BUDGETS,
    logging: { maxBytes: 1_000_000, retentionDays: 14 },
  };
}

void test("strict configuration validates routes, workers, projects, and Gate references", () => {
  const root = path.join(os.tmpdir(), "orchestrator-config");
  assert.equal(parseConfig(config(root)).version, CONFIG_VERSION);
  assert.throws(() =>
    parseConfig({
      ...config(root),
      routing: {
        ...config(root).routing,
        critical: { implementation: "missing", review: "review" },
      },
    }),
  );
  const duplicate = config(root);
  const duplicateProject = duplicate.projects.example;
  assert.ok(duplicateProject);
  const firstGate = duplicateProject.gates.affected[0];
  assert.ok(firstGate);
  assert.throws(() =>
    parseConfig({
      ...duplicate,
      projects: {
        example: {
          ...duplicateProject,
          gates: {
            ...duplicateProject.gates,
            acceptance: {
              ...duplicateProject.gates.acceptance,
              id: "unit",
            },
          },
        },
      },
    }),
  );
  assert.throws(() =>
    parseConfig({
      ...duplicate,
      projects: {
        example: {
          ...duplicateProject,
          gates: {
            affected: [
              {
                ...firstGate,
                dependsOn: ["acceptance"],
              },
            ],
            acceptance: {
              ...duplicateProject.gates.acceptance,
              dependsOn: ["unit"],
            },
          },
        },
      },
    }),
  );
});

void test("configuration repository writes atomically and refuses accidental re-initialization", () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "orchestrator-config-file-"));
  const file = path.join(temporary, "config.json");
  const repository = new ConfigFileRepository(file);
  try {
    repository.requireAbsent();
    repository.write(config(temporary));
    assert.equal(repository.read().defaultProject, "example");
    assert.throws(() => repository.requireAbsent());
    assert.deepEqual(
      fs.readdirSync(temporary).filter((entry) => entry.endsWith(".tmp")),
      [],
    );
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});

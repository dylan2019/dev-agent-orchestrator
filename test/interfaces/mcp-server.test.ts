import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

import { ConfigFileRepository } from "../../src/configuration/file-repository.js";
import { CONFIG_VERSION, type OrchestratorConfig } from "../../src/configuration/schema.js";
import { DEFAULT_BUDGETS } from "../../src/domain/budgets.js";

function config(temporary: string): OrchestratorConfig {
  const worker = {
    adapter: "cursor" as const,
    command: process.execPath,
    args: [],
    model: "model",
    shellAllow: [],
  };
  return {
    version: CONFIG_VERSION,
    defaultProject: "example",
    runtime: { gitCommand: process.execPath },
    workers: {
      implementation: worker,
      review: { ...worker, adapter: "antigravity" },
    },
    routing: {
      normal: { implementation: "implementation", review: "review" },
      high: { implementation: "implementation", review: "review" },
      critical: { implementation: "implementation", review: "review" },
    },
    projects: {
      example: {
        repository: path.join(temporary, "repository"),
        targetBranch: "main",
        worktreeRoot: path.join(temporary, "worktrees"),
        instructionFiles: [],
        gates: {
          affected: [
            {
              id: "unit",
              command: process.execPath,
              args: ["--version"],
              dependsOn: [],
              timeoutMinutes: 1,
            },
          ],
          acceptance: {
            id: "acceptance",
            command: process.execPath,
            args: ["--version"],
            dependsOn: ["unit"],
            timeoutMinutes: 1,
          },
        },
      },
    },
    budgets: DEFAULT_BUDGETS,
    logging: { maxBytes: 64_000, retentionDays: 14 },
  };
}

void test("MCP exposes only the five public product tools", async () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "orchestrator-mcp-"));
  fs.mkdirSync(path.join(temporary, "repository"));
  new ConfigFileRepository(path.join(temporary, "config.json")).write(config(temporary));
  const serverFile = path.resolve(
    import.meta.dirname,
    "..",
    "..",
    "src",
    "interfaces",
    "mcp",
    "server.js",
  );
  const environment = Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string",
    ),
  );
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [serverFile],
    env: { ...environment, DEV_AGENT_ORCHESTRATOR_HOME: temporary },
    stderr: "pipe",
  });
  const client = new Client({ name: "orchestrator-test", version: "1.0.0" });
  try {
    await client.connect(transport);
    const tools = await client.listTools();
    assert.deepEqual(tools.tools.map((tool) => tool.name).sort(), [
      "orchestrator_decide",
      "orchestrator_doctor",
      "orchestrator_get_candidate",
      "orchestrator_observe",
      "orchestrator_start",
    ]);
    const start = tools.tools.find((tool) => tool.name === "orchestrator_start");
    const properties = (start?.inputSchema as { readonly properties?: Record<string, unknown> })
      .properties;
    assert.equal(properties?.model, undefined);
    assert.equal(properties?.worker, undefined);
  } finally {
    await client.close();
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});

import fs from "node:fs";
import path from "node:path";

import { toJSONSchema } from "zod";

import { OrchestratorConfigSchema } from "../dist/src/configuration/schema.js";

const output = path.resolve("config", "orchestrator.schema.json");
const schema = toJSONSchema(OrchestratorConfigSchema, {
  target: "draft-2020-12",
  unrepresentable: "throw",
});
const content = `${JSON.stringify(
  {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    $id: "https://github.com/dylan2019/dev-agent-orchestrator/config/orchestrator.schema.json",
    title: "Dev Agent Orchestrator Configuration",
    ...schema,
  },
  null,
  2,
)}\n`;

if (process.argv.includes("--check")) {
  const current = fs.existsSync(output) ? fs.readFileSync(output, "utf8") : "";
  if (current !== content) {
    throw new Error("config/orchestrator.schema.json is stale; run npm run schema:generate");
  }
} else {
  fs.writeFileSync(output, content, "utf8");
}

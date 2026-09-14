import { execFileSync } from "node:child_process";
import fs from "node:fs";

const metadata = JSON.parse(fs.readFileSync("package.json", "utf8"));
const lock = JSON.parse(fs.readFileSync("package-lock.json", "utf8"));
const version = metadata.version;

if (version !== "1.0.0" || lock.version !== version || lock.packages?.[""]?.version !== version) {
  throw new Error("package and lockfile versions must be 1.0.0");
}
for (const [file, marker] of [
  ["README.md", "Current release: `1.0.0`"],
  ["SECURITY.md", "`1.0.x`"],
  ["CHANGELOG.md", "## 1.0.0 - "],
  ["LICENSE", "Apache License"],
]) {
  if (!fs.readFileSync(file, "utf8").includes(marker)) {
    throw new Error(`${file} is missing release metadata`);
  }
}

execFileSync(process.execPath, ["scripts/generate-schema.mjs", "--check"], { stdio: "inherit" });

const schema = JSON.parse(fs.readFileSync("config/orchestrator.schema.json", "utf8"));
const example = JSON.parse(fs.readFileSync("config/config.example.json", "utf8"));
if (
  schema.$schema !== "https://json-schema.org/draft/2020-12/schema" ||
  example.version !== "1.0.0"
) {
  throw new Error("configuration schema or example is invalid");
}

const server = fs.readFileSync("src/interfaces/mcp/server.ts", "utf8");
const tools = [...server.matchAll(/server\.registerTool\(\s*"([^"]+)"/g)]
  .map((match) => match[1])
  .sort();
const expectedTools = [
  "orchestrator_decide",
  "orchestrator_doctor",
  "orchestrator_get_candidate",
  "orchestrator_observe",
  "orchestrator_start",
];
if (JSON.stringify(tools) !== JSON.stringify(expectedTools)) {
  throw new Error(`public MCP tools changed: ${tools.join(", ")}`);
}

const tracked = execFileSync("git", ["ls-files"], { encoding: "utf8" })
  .split(/\r?\n/)
  .filter(Boolean);
const forbidden = tracked.filter(
  (file) =>
    file.startsWith("dist/") ||
    file.startsWith("node_modules/") ||
    file.startsWith(".runtime/") ||
    /(?:^|\/)(?:\.env(?:\..*)?|.*\.(?:key|pem|p12|pfx))$/i.test(file) ||
    /\.log$/i.test(file),
);
if (forbidden.length > 0) {
  throw new Error(`release contains forbidden files: ${forbidden.join(", ")}`);
}

const workflow = fs.readFileSync(".github/workflows/ci.yml", "utf8");
const unpinned = [...workflow.matchAll(/uses:\s*[^\s@]+@([^\s#]+)/g)]
  .map((match) => match[1])
  .filter((reference) => !/^[a-f0-9]{40}$/.test(reference));
if (unpinned.length > 0) {
  throw new Error(`GitHub Actions must use commit SHAs: ${unpinned.join(", ")}`);
}
if (!workflow.includes('tags: ["v*"]') || !workflow.includes("gh release create")) {
  throw new Error("release workflow is incomplete");
}

if (process.env.GITHUB_REF_TYPE === "tag" && process.env.GITHUB_REF_NAME !== `v${version}`) {
  throw new Error(`tag ${process.env.GITHUB_REF_NAME ?? "unknown"} does not match v${version}`);
}

process.stdout.write(`release ${version} metadata, schema, API, and tracked files verified\n`);

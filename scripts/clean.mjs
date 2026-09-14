import fs from "node:fs";
import path from "node:path";

const projectRoot = path.resolve(import.meta.dirname, "..");
const output = path.join(projectRoot, "dist");

if (fs.existsSync(output)) {
  fs.rmSync(output, { recursive: true, force: true });
}

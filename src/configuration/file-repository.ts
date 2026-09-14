import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { parseConfig, type OrchestratorConfig } from "./schema.js";
import { OrchestratorError, wrapError } from "../shared/errors.js";

export class ConfigFileRepository {
  public constructor(private readonly file: string) {}

  public read(): OrchestratorConfig {
    try {
      return parseConfig(JSON.parse(fs.readFileSync(this.file, "utf8")) as unknown);
    } catch (error) {
      throw wrapError("CONFIG_READ_FAILED", "Unable to read orchestrator configuration", error, {
        file: this.file,
      });
    }
  }

  public write(config: OrchestratorConfig): void {
    const validated = parseConfig(config);
    const directory = path.dirname(path.resolve(this.file));
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    const temporary = path.join(
      directory,
      `.config.${String(process.pid)}.${String(Date.now())}.${crypto.randomUUID()}.tmp`,
    );
    try {
      fs.writeFileSync(temporary, `${JSON.stringify(validated, null, 2)}\n`, {
        encoding: "utf8",
        mode: 0o600,
      });
      fs.renameSync(temporary, this.file);
      if (process.platform !== "win32") {
        fs.chmodSync(this.file, 0o600);
      }
    } catch (error) {
      try {
        if (fs.existsSync(temporary)) {
          fs.unlinkSync(temporary);
        }
      } catch {
        // The primary configuration write error remains authoritative.
      }
      throw wrapError("CONFIG_WRITE_FAILED", "Unable to write orchestrator configuration", error, {
        file: this.file,
      });
    }
  }

  public exists(): boolean {
    return fs.existsSync(this.file);
  }

  public requireAbsent(): void {
    if (this.exists()) {
      throw new OrchestratorError("CONFIG_ALREADY_EXISTS", "Configuration already exists", {
        file: this.file,
      });
    }
  }
}

import assert from "node:assert/strict";
import test from "node:test";

import { DomainError } from "../../src/domain/errors.js";
import {
  isEnvironmentTemplatePath,
  normalizeAuthorizedPaths,
  pathIsCovered,
  scopePreservesAndExpands,
} from "../../src/domain/scope.js";

void test("scope normalization allows explicit templates and rejects secrets or traversal", () => {
  assert.deepEqual(normalizeAuthorizedPaths(["src\\domain", ".env.nacos.example", "src/domain"]), [
    ".env.nacos.example",
    "src/domain",
  ]);
  assert.equal(isEnvironmentTemplatePath("config/.env.service.template"), true);
  assert.equal(pathIsCovered("src/domain/task.ts", ["src/domain"]), true);
  assert.equal(scopePreservesAndExpands(["src/domain"], ["src", "test"]), true);
  for (const invalid of [
    ".",
    "../outside",
    ".git/config",
    ".env",
    ".env.production",
    "tls/server.key",
  ]) {
    assert.throws(
      () => normalizeAuthorizedPaths([invalid]),
      (error: unknown) => error instanceof DomainError && error.code === "INVALID_SCOPE_PATH",
    );
  }
});

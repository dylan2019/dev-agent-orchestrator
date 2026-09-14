import { assertDomain } from "./errors.js";

export function isEnvironmentTemplatePath(input: string): boolean {
  const name = input.replaceAll("\\", "/").split("/").at(-1)?.toLowerCase() ?? "";
  return /^\.env(?:\.[a-z0-9_-]+)*\.(?:example|sample|template)$/.test(name);
}

export function normalizeAuthorizedPath(input: string): string {
  const normalized = input.trim().replaceAll("\\", "/").replace(/^\.\//, "").replace(/\/$/, "");
  const lower = normalized.toLowerCase();
  const hasSensitiveSegment = lower
    .split("/")
    .some(
      (segment) =>
        (segment === ".env" || segment.startsWith(".env.")) && !isEnvironmentTemplatePath(segment),
    );
  assertDomain(
    normalized.length > 0 &&
      normalized !== "." &&
      !normalized.startsWith("/") &&
      !/^[a-z]:/i.test(normalized) &&
      !normalized.split("/").includes("..") &&
      normalized !== ".git" &&
      !normalized.startsWith(".git/") &&
      !hasSensitiveSegment &&
      !/\.(?:key|pem|p12|pfx|jks|keystore)$/i.test(normalized),
    "INVALID_SCOPE_PATH",
    `Path cannot be authorized: ${input}`,
  );
  return normalized;
}

export function normalizeAuthorizedPaths(inputs: readonly string[]): readonly string[] {
  const normalized = [...new Set(inputs.map(normalizeAuthorizedPath))].sort();
  assertDomain(normalized.length > 0, "EMPTY_SCOPE", "At least one authorized path is required");
  return normalized;
}

export function pathIsCovered(file: string, authorizedPaths: readonly string[]): boolean {
  const normalized = file.replaceAll("\\", "/");
  return authorizedPaths.some(
    (authorized) => normalized === authorized || normalized.startsWith(`${authorized}/`),
  );
}

export function scopePreservesAndExpands(
  previous: readonly string[],
  requested: readonly string[],
): boolean {
  const preserves = previous.every((path) => pathIsCovered(path, requested));
  const expands = requested.some((path) => !pathIsCovered(path, previous));
  return preserves && expands;
}

export class OrchestratorError extends Error {
  public constructor(
    public readonly code: string,
    message: string,
    public readonly details?: Readonly<Record<string, unknown>>,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "OrchestratorError";
  }
}

export function wrapError(
  code: string,
  message: string,
  error: unknown,
  details?: Readonly<Record<string, unknown>>,
): OrchestratorError {
  if (error instanceof OrchestratorError) {
    return error;
  }
  return new OrchestratorError(code, message, details, {
    cause: error instanceof Error ? error : new Error(String(error)),
  });
}

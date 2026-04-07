/**
 * Core error hierarchy.
 *
 * All domain service errors throw CoreError subclasses.
 * CLI wraps them into PinEnvelope; Server wraps them into HTTP responses.
 */

export type CoreErrorType =
  | "validation"
  | "not_found"
  | "conflict"
  | "provider_unavailable"
  | "internal"
  | "not_implemented";

export class CoreError extends Error {
  constructor(
    public readonly type: CoreErrorType,
    public readonly code: string,
    message: string,
    public readonly hint?: string,
  ) {
    super(message);
    this.name = "CoreError";
  }
}

export class ValidationError extends CoreError {
  constructor(code: string, message: string, hint?: string) {
    super("validation", code, message, hint);
    this.name = "ValidationError";
  }
}

export class NotFoundError extends CoreError {
  constructor(code: string, message: string, hint?: string) {
    super("not_found", code, message, hint);
    this.name = "NotFoundError";
  }
}

export class ConflictError extends CoreError {
  constructor(code: string, message: string, hint?: string) {
    super("conflict", code, message, hint);
    this.name = "ConflictError";
  }
}

export class ProviderUnavailableError extends CoreError {
  constructor(code: string, message: string, hint?: string) {
    super("provider_unavailable", code, message, hint);
    this.name = "ProviderUnavailableError";
  }
}

export class InternalError extends CoreError {
  constructor(code: string, message: string, hint?: string) {
    super("internal", code, message, hint);
    this.name = "InternalError";
  }
}

export class NotImplementedError extends CoreError {
  constructor(code: string, message: string, hint?: string) {
    super("not_implemented", code, message, hint);
    this.name = "NotImplementedError";
  }
}

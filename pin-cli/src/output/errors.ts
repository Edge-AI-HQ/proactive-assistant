export const ExitOK = 0;
export const ExitBusiness = 1;
export const ExitValidation = 2;

export const ErrorType = {
  VALIDATION: "validation",
  NOT_FOUND: "not_found",
  CONFLICT: "conflict",
  PROVIDER_UNAVAILABLE: "provider_unavailable",
  INTERNAL: "internal",
  NOT_IMPLEMENTED: "not_implemented",
} as const;

export type ErrorTypeValue = (typeof ErrorType)[keyof typeof ErrorType];

export const exitCodeForType = (type: ErrorTypeValue): number => {
  if (type === ErrorType.VALIDATION) return ExitValidation;
  return ExitBusiness;
};

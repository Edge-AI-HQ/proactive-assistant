/**
 * Core → CLI adapter utilities.
 *
 * Wraps @pin-ai/core service calls into RunCliResult with PinEnvelope.
 * Used by all domain service files to delegate logic to core.
 */

import { CoreError } from "@pin-ai/core";
import { okEnvelope, errorEnvelope, type PinNotice } from "./envelope.js";
import { exitCodeForType, type ErrorTypeValue } from "./errors.js";
import type { RunCliResult } from "../runtime.js";

/**
 * Call a core service function and wrap the result in a CLI envelope.
 * Core errors are caught and converted to error envelopes.
 */
export const callCore = async <T>(
  domain: string,
  command: string,
  fn: () => T | Promise<T>,
  notice?: Record<string, PinNotice>,
): Promise<RunCliResult> => {
  try {
    const data = await fn();
    return {
      exitCode: 0,
      stdout: okEnvelope(domain, command, data, notice),
    };
  } catch (error) {
    if (error instanceof CoreError) {
      return {
        exitCode: exitCodeForType(error.type as ErrorTypeValue),
        stdout: errorEnvelope(
          domain,
          command,
          error.type,
          error.code,
          error.message,
          error.hint,
        ),
      };
    }
    throw error;
  }
};

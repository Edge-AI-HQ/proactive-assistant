/**
 * Types for the design-token SSOT (tokens.cjs). Lets TS consumers (RN
 * typography, future Electron) import the tokens with types; the web
 * tailwind.config imports the .cjs directly and does not need these.
 */
export declare const colors: Record<string, unknown>;
export declare const borderRadius: Record<"lg" | "md" | "sm", string>;
export declare const cssVariables: string;
export declare const letterSpacingEm: { tight: number; display: number };

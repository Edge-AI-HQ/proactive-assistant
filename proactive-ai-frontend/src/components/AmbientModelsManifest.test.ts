import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, test } from "vitest";

const manifest = readFileSync(
  resolve(process.cwd(), "../capacitor-plugins/ambient-ai/ios/Sources/AmbientAi/Models/ModelManifest.swift"),
  "utf8",
);

describe("native ambient model manifest", () => {
  test("offers the updated Gemma profiles and removes deprecated tiny/1B entries", () => {
    expect(manifest).toContain('id: "gemma-2-2b-q4"');
    expect(manifest).toContain('repo: "unsloth/gemma-2-it-GGUF"');
    expect(manifest).toContain('file: "gemma-2-2b-it.q4_k_m.gguf"');
    expect(manifest).toContain('id: "gemma-3-4b-q4"');
    expect(manifest).toContain('repo: "unsloth/gemma-3-4b-it-GGUF"');
    expect(manifest).toContain('file: "gemma-3-4b-it-Q4_K_M.gguf"');

    expect(manifest).not.toContain('id: "whisper-tiny-q5_1"');
    expect(manifest).not.toContain('id: "whisper-tiny"');
    expect(manifest).not.toContain('id: "llama-3_2-1b-q4"');
    expect(manifest).not.toContain('id: "gemma-3-1b-q4"');
  });
});

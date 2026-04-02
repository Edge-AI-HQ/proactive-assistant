import OpenAI from "openai";

import type { CliRuntimeInput } from "../../runtime.js";

export interface PersonalEmbeddingProvider {
  model: string;
  embedTexts(texts: string[]): Promise<number[][]>;
}

class NoopPersonalEmbeddingProvider implements PersonalEmbeddingProvider {
  model = "unavailable";

  async embedTexts(): Promise<number[][]> {
    throw new Error("OpenAI embeddings are unavailable");
  }
}

class OpenAiPersonalEmbeddingProvider implements PersonalEmbeddingProvider {
  readonly model = "text-embedding-3-small";
  private readonly client: OpenAI;

  constructor(apiKey: string) {
    this.client = new OpenAI({ apiKey });
  }

  async embedTexts(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) {
      return [];
    }

    const response = await this.client.embeddings.create({
      model: this.model,
      input: texts,
    });

    return response.data.map((item) => item.embedding);
  }
}

export const createPersonalEmbeddingProvider = (
  runtime: CliRuntimeInput,
  override?: PersonalEmbeddingProvider,
): PersonalEmbeddingProvider => {
  if (override) {
    return override;
  }

  const apiKey = runtime.env.OPENAI_API_KEY;
  if (!apiKey) {
    return new NoopPersonalEmbeddingProvider();
  }

  return new OpenAiPersonalEmbeddingProvider(apiKey);
};

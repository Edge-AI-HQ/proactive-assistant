import OpenAI from "openai";

import type { CoreContext } from "../../context.js";

export interface WorldEmbeddingProvider {
  model: string;
  embedTexts(texts: string[]): Promise<number[][]>;
}

class NoopWorldEmbeddingProvider implements WorldEmbeddingProvider {
  model = "unavailable";

  async embedTexts(): Promise<number[][]> {
    throw new Error("OpenAI embeddings are unavailable");
  }
}

class OpenAiWorldEmbeddingProvider implements WorldEmbeddingProvider {
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

export const createWorldEmbeddingProvider = (
  ctx: CoreContext,
  override?: WorldEmbeddingProvider,
): WorldEmbeddingProvider => {
  if (override) {
    return override;
  }

  const apiKey = ctx.env.OPENAI_API_KEY;
  if (!apiKey) {
    return new NoopWorldEmbeddingProvider();
  }

  return new OpenAiWorldEmbeddingProvider(apiKey);
};

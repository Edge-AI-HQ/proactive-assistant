/**
 * World item embedding provider.
 *
 * Uses OpenAI text-embedding-3-small via the LiteLLM proxy (if configured)
 * or direct OpenAI API.
 *
 * Adapted from _deprecated/proactive-ai/src/core/domains/world/embedding.ts
 */

export interface WorldEmbeddingProvider {
  model: string;
  embedTexts(texts: string[]): Promise<number[][]>;
}

class NoopWorldEmbeddingProvider implements WorldEmbeddingProvider {
  model = 'unavailable';

  async embedTexts(): Promise<number[][]> {
    throw new Error('Embedding provider unavailable — set OPENAI_API_KEY or LITELLM_API_KEY');
  }
}

class OpenAiWorldEmbeddingProvider implements WorldEmbeddingProvider {
  readonly model = 'text-embedding-3-small';
  private readonly apiKey: string;
  private readonly baseUrl: string | undefined;

  constructor(apiKey: string, baseUrl?: string) {
    this.apiKey = apiKey;
    this.baseUrl = baseUrl;
  }

  async embedTexts(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];

    // Use OpenAI-compatible API (works with LiteLLM proxy too)
    const url = `${this.baseUrl || 'https://api.openai.com/v1'}/embeddings`;
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({ model: this.model, input: texts }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`Embedding API failed: ${res.status} ${body.slice(0, 200)}`);
    }
    const data = await res.json() as { data: Array<{ embedding: number[] }> };
    return data.data.map(item => item.embedding);
  }
}

let _instance: WorldEmbeddingProvider | null = null;

/**
 * Get or create embedding provider singleton.
 *
 * Priority: LITELLM_API_KEY + LITELLM_BASE_URL > OPENAI_API_KEY > Noop
 */
export function getWorldEmbeddingProvider(): WorldEmbeddingProvider {
  if (_instance) return _instance;

  // LiteLLM proxy (inside container)
  const litellmKey = process.env.LITELLM_API_KEY;
  const litellmBase = process.env.LITELLM_BASE_URL;
  if (litellmKey && litellmBase) {
    _instance = new OpenAiWorldEmbeddingProvider(litellmKey, litellmBase);
    return _instance;
  }

  // Direct OpenAI
  const openaiKey = process.env.OPENAI_API_KEY;
  if (openaiKey) {
    _instance = new OpenAiWorldEmbeddingProvider(openaiKey);
    return _instance;
  }

  _instance = new NoopWorldEmbeddingProvider();
  return _instance;
}

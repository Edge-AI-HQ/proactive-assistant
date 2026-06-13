/**
 * Streaming-markdown block splitter — the pure core of the block-memo render
 * strategy (Vercel streamdown's approach): split assistant text into blocks at
 * blank lines so a finished block can be memoized and never re-parsed, while
 * only the last (still-streaming) block re-renders per token. Replaces the
 * O(N) "re-parse the whole message on every token" degradation.
 *
 * Shared so web and RN render the same block boundaries; today only RN
 * (apps/mobile MarkdownText) consumes it, with the web ReactMarkdown path to
 * follow. Trade-off (same as web streamdown): cross-block link-reference
 * definitions are not resolved — LLM output is almost always inline links.
 */

/** Split into blocks at blank lines; ``` / ~~~ fences are never split inside. */
export function splitBlocks(text: string): string[] {
  const lines = text.split("\n");
  const blocks: string[] = [];
  let cur: string[] = [];
  let inFence = false;
  const flush = () => {
    const joined = cur.join("\n");
    if (joined.trim()) blocks.push(joined);
    cur = [];
  };
  for (const line of lines) {
    if (/^(```|~~~)/.test(line.trimStart())) inFence = !inFence;
    cur.push(line);
    if (!inFence && line.trim() === "") flush();
  }
  flush();
  return blocks;
}

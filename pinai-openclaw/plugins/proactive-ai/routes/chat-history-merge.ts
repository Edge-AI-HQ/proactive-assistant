/**
 * Merge raw subagent session transcript messages into Claude-style turns.
 *
 * The subagent persists each assistant emission and each toolResult as a
 * separate `role=` message. One conceptual "agent turn" often spans several
 * of these (text, toolCall, toolResult, text, …). Rendering them as
 * independent bubbles produces duplicate Copy buttons and drops toolCall
 * information from history.
 *
 * This helper walks the transcript in order and merges each
 * assistant+toolResult chain back into a single assistant turn whose
 * `parts[]` preserve order: text blocks and tool-call blocks interleaved,
 * with tool-call results matched back to their calls by `toolCallId`.
 *
 * Output shape is safe for frontend consumption and mirrors the live SSE
 * content snapshot (see `proactive-ai-frontend/src/components/chat/tool-steps.ts`
 * for the corresponding runtime path).
 */
import { extractTextContent } from './types.js';
import {
  INJECTED_CARD_CHAT_PREFIX,
  stripTimestampEnvelope,
} from '../chat-feedback/service.js';
import { previewToolArgs, detectPinCommand } from './chat.js';

export interface HistoryTextPart {
  type: 'text';
  text: string;
}

export interface HistoryToolCallPart {
  type: 'tool-call';
  toolCallId: string;
  toolName: string;
  status: 'running' | 'ok' | 'error';
  meta?: string;
  argsPreview?: string;
  pinCommand?: string;
}

export type HistoryPart = HistoryTextPart | HistoryToolCallPart;

export interface HistoryMessage {
  id: string;
  role: 'user' | 'assistant';
  parts: HistoryPart[];
  createdAt?: number;
}

interface RawMessage {
  role?: string;
  content?: unknown;
  timestamp?: unknown;
  toolCallId?: unknown;
  isError?: unknown;
}

interface RawContentPart {
  type?: string;
  text?: string;
  id?: string;
  name?: string;
  arguments?: unknown;
}

const TOOL_RESULT_META_MAX = 200;

function asNumberOrUndefined(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function summarizeResult(content: unknown): string | undefined {
  const text = extractTextContent(content).trim();
  if (!text) return undefined;
  return text.length > TOOL_RESULT_META_MAX
    ? `${text.slice(0, TOOL_RESULT_META_MAX - 1)}…`
    : text;
}

/**
 * Walk the raw transcript and emit Claude-style merged turns.
 *
 * Rules:
 *  - `user` messages close any open assistant turn and emit themselves.
 *    User content has the OpenClaw timestamp envelope stripped.
 *  - Consecutive `assistant` + `toolResult` messages fold into one assistant
 *    turn. Assistant `text` and `toolCall` parts are appended in order;
 *    `thinking` parts are dropped (private reasoning, not UI content).
 *  - `toolResult` messages match back to the most recent tool-call in the
 *    open turn by `toolCallId`, attaching status + a short meta preview.
 *  - Empty assistant turns (no text, no tools after folding) are skipped.
 */
export function mergeChatHistoryTurns(raw: readonly unknown[]): HistoryMessage[] {
  const out: HistoryMessage[] = [];
  let pendingAssistant: HistoryMessage | null = null;
  const toolCallIndex = new Map<string, number>();
  let seq = 0;

  const flushAssistant = () => {
    if (!pendingAssistant) return;
    const hasText = pendingAssistant.parts.some(
      (p) => p.type === 'text' && p.text.trim().length > 0,
    );
    const hasTool = pendingAssistant.parts.some((p) => p.type === 'tool-call');
    if (hasText || hasTool) {
      out.push(pendingAssistant);
    }
    pendingAssistant = null;
    toolCallIndex.clear();
  };

  for (const rawMsg of raw) {
    if (!rawMsg || typeof rawMsg !== 'object') continue;
    const m = rawMsg as RawMessage;
    const createdAt = asNumberOrUndefined(m.timestamp);

    if (m.role === 'user') {
      flushAssistant();
      const text = stripTimestampEnvelope(extractTextContent(m.content)).trim();
      if (!text) continue;
      // Card chat bootstrap sends a synthesized first user message
      // ("The user opened '...'. Suggested action: ...") to seed the agent's
      // first reply. It's plumbing, not a real user utterance, so hide it
      // from the rendered transcript (mirrors normalizeCardChatMessages).
      if (text.startsWith(INJECTED_CARD_CHAT_PREFIX)) continue;
      out.push({
        id: `user-${seq++}`,
        role: 'user',
        parts: [{ type: 'text', text }],
        createdAt,
      });
      continue;
    }

    if (m.role === 'assistant') {
      if (!pendingAssistant) {
        pendingAssistant = {
          id: `assistant-${seq++}`,
          role: 'assistant',
          parts: [],
          createdAt,
        };
      }
      const content = Array.isArray(m.content) ? (m.content as RawContentPart[]) : [];
      for (const part of content) {
        if (!part || typeof part !== 'object') continue;
        if (part.type === 'text' && typeof part.text === 'string' && part.text) {
          pendingAssistant.parts.push({ type: 'text', text: part.text });
          continue;
        }
        if (
          part.type === 'toolCall' &&
          typeof part.id === 'string' && part.id &&
          typeof part.name === 'string' && part.name
        ) {
          const toolPart: HistoryToolCallPart = {
            type: 'tool-call',
            toolCallId: part.id,
            toolName: part.name,
            status: 'ok', // updated when a matching toolResult arrives
          };
          const argsPreview = previewToolArgs(part.arguments);
          if (argsPreview) toolPart.argsPreview = argsPreview;
          const pinCommand = detectPinCommand(part.name, part.arguments);
          if (pinCommand) toolPart.pinCommand = pinCommand;
          toolCallIndex.set(part.id, pendingAssistant.parts.length);
          pendingAssistant.parts.push(toolPart);
          continue;
        }
        // thinking / other types: deliberately dropped.
      }
      continue;
    }

    if (m.role === 'toolResult') {
      if (!pendingAssistant) continue;
      const toolCallId =
        typeof m.toolCallId === 'string' && m.toolCallId ? m.toolCallId : undefined;
      if (!toolCallId) continue;
      const idx = toolCallIndex.get(toolCallId);
      if (idx === undefined) continue;
      const slot = pendingAssistant.parts[idx];
      if (!slot || slot.type !== 'tool-call') continue;
      const isError = Boolean(m.isError);
      slot.status = isError ? 'error' : 'ok';
      const summary = summarizeResult(m.content);
      if (summary && !slot.meta) slot.meta = summary;
      continue;
    }
    // other roles (system / model_change / etc.): skip
  }

  flushAssistant();
  return out;
}

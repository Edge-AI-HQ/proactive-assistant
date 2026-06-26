/**
 * HITL 审批文案 — 把一个暂停在副作用工具上的 agent run 转成「人话动作」，
 * 而不是把 Composio meta-tool 的 raw JSON 摊给用户看（非技术用户读到的应是
 * 一个动作，不是 `{"calls":[{"slug":...}]}`）。
 *
 * 双端共用此纯逻辑（Share logic, not UI）：web 的 ui-web `HitlApprovalCard`
 * 与 RN 的 apps/mobile `ChatScreen` 各写 UI 壳、共消费本函数。
 *
 * 今天经 HITL 门控的副作用工具（preference_add / COMPOSIO_MULTI_EXECUTE_TOOL）
 * 各有模板；未来新工具回退到 humanize 名 + argsPreview，仍能渲染。
 */

export interface ApprovalCopy {
  title: string;
  detail?: string;
}

/** Turn an upper/snake-case tool or SaaS slug into readable sentence case:
 *  `GMAIL_SEND_DRAFT` → `Gmail send draft`. The open-ended set of Composio
 *  slugs (1000+) can't be enumerated, so we derive a label instead. */
export function humanizeSlug(slug: string): string {
  const s = slug.replace(/[_-]+/g, " ").trim().toLowerCase();
  return s ? s[0].toUpperCase() + s.slice(1) : slug;
}

/** A `calls[]` entry comes straight from the LLM. Despite the prompt asking
 *  for `{tool_slug, arguments}`, the model frequently shortens the key to
 *  `slug` (and `arguments` to `args`) — accept all variants so humanization
 *  fires instead of falling back to raw JSON. */
function callSlug(call: unknown): string | undefined {
  if (!call || typeof call !== "object") return undefined;
  const o = call as Record<string, unknown>;
  const slug = o.tool_slug ?? o.slug ?? o.name;
  return typeof slug === "string" ? slug : undefined;
}

/** Turn a paused side-effect tool call into human-friendly card copy. */
export function describeApproval(
  toolName: string,
  args: Record<string, unknown> | undefined,
  argsPreview: string | undefined,
): ApprovalCopy {
  const a = args ?? {};

  switch (toolName) {
    case "preference_add": {
      // `statement` is the user's own one-sentence framing — show it verbatim;
      // scope / polarity / card_id are internal mechanics, intentionally hidden.
      const statement = typeof a.statement === "string" ? a.statement : undefined;
      return { title: "Save a preference", detail: statement ?? argsPreview };
    }
    case "COMPOSIO_MULTI_EXECUTE_TOOL": {
      // Meta-tool: `calls` is a batch of {tool_slug|slug, arguments|args}. We
      // can't write copy per SaaS tool, so label each by its humanized slug.
      const calls = Array.isArray(a.calls) ? a.calls : [];
      const actions = calls
        .map(callSlug)
        .filter((s): s is string => typeof s === "string")
        .map(humanizeSlug);
      if (actions.length === 0) return { title: "Run an action", detail: argsPreview };
      if (actions.length === 1) return { title: actions[0] };
      return {
        title: `Run ${actions.length} actions`,
        detail: actions.map((s) => `• ${s}`).join("\n"),
      };
    }
    default:
      // Future side-effect tool with no template yet: humanize the name.
      return { title: humanizeSlug(toolName), detail: argsPreview };
  }
}

import test from "node:test";
import assert from "node:assert/strict";

import { resolveIncomingChatMessage, shouldInterceptBrowserFirstCall } from "./chat.ts";

test("cardContext only falls back to injected first message", () => {
  assert.equal(
    resolveIncomingChatMessage({
      message: undefined,
      firstMessage: 'The user opened "Quiet Hours". Suggested action: "Enable quiet hours". Confirm details briefly, then execute.',
    }),
    'The user opened "Quiet Hours". Suggested action: "Enable quiet hours". Confirm details briefly, then execute.',
  );
});

test("user message wins when message and cardContext arrive together", () => {
  assert.equal(
    resolveIncomingChatMessage({
      message: "确认，到时候我需要做什么",
      firstMessage: 'The user opened "Quiet Hours". Suggested action: "Enable quiet hours". Confirm details briefly, then execute.',
    }),
    "确认，到时候我需要做什么",
  );
});

/* ------------------------------------------------------------------ */
/*  Browser-first-call intercept (Tier policy light hard intercept)    */
/* ------------------------------------------------------------------ */

test("intercept: first browser open with no prior pin tool → intercept", () => {
  const result = shouldInterceptBrowserFirstCall({
    toolName: "browser",
    toolArgs: { action: "open", url: "https://mail.google.com" },
    priorToolCallsInRun: [],
    userMessage: "check my emails",
  });
  assert.equal(result.intercept, true);
  assert.match(result.reminder ?? "", /Tier|pin raw|pin personal exec/i);
});

test("intercept: prior pin raw + pin web fetch same host → do not intercept", () => {
  // Rule 1 (Tier 1/2 grounding) AND rule 2 (web fetch on this host) both
  // satisfied — the agent has done its homework, browser open passes.
  const result = shouldInterceptBrowserFirstCall({
    toolName: "browser",
    toolArgs: { action: "open", url: "https://mail.google.com/u/0/inbox" },
    priorToolCallsInRun: [
      { name: "exec", args: { command: "pin raw gmail recent --hours 24" } },
      { name: "exec", args: { command: "pin web fetch --url https://mail.google.com/u/0/inbox" } },
    ],
    userMessage: "check my emails",
  });
  assert.equal(result.intercept, false);
});

test("intercept: prior pin personal exec + web fetch same host → do not intercept", () => {
  const result = shouldInterceptBrowserFirstCall({
    toolName: "browser",
    toolArgs: { action: "open", url: "https://mail.google.com" },
    priorToolCallsInRun: [
      { name: "exec", args: { command: "pin personal exec --tool GMAIL_FETCH_EMAILS" } },
      { name: "exec", args: { command: "pin web fetch --url https://mail.google.com" } },
    ],
    userMessage: "check my emails",
  });
  assert.equal(result.intercept, false);
});

test("intercept: user explicitly mentions browser → do not intercept", () => {
  const result = shouldInterceptBrowserFirstCall({
    toolName: "browser",
    toolArgs: { action: "open", url: "https://mail.google.com" },
    priorToolCallsInRun: [],
    userMessage: "open Gmail in the browser to look at it",
  });
  assert.equal(result.intercept, false);
});

test("intercept: user mentions Chinese 网页 / 网站 / 浏览 → do not intercept", () => {
  for (const message of ["打开网页", "我想看那个网站", "帮我浏览一下"]) {
    const result = shouldInterceptBrowserFirstCall({
      toolName: "browser",
      toolArgs: { action: "open", url: "https://example.com" },
      priorToolCallsInRun: [],
      userMessage: message,
    });
    assert.equal(result.intercept, false, `should not intercept: "${message}"`);
  }
});

test("intercept: non-browser tool → do not intercept", () => {
  const result = shouldInterceptBrowserFirstCall({
    toolName: "exec",
    toolArgs: { command: "pin raw gmail recent" },
    priorToolCallsInRun: [],
    userMessage: "check my emails",
  });
  assert.equal(result.intercept, false);
});

test("intercept: browser action other than open → do not intercept", () => {
  const result = shouldInterceptBrowserFirstCall({
    toolName: "browser",
    toolArgs: { action: "click", ref: "e3" },
    priorToolCallsInRun: [],
    userMessage: "click submit",
  });
  assert.equal(result.intercept, false);
});

test("intercept: agent retries browser open after inject → do not intercept again", () => {
  const result = shouldInterceptBrowserFirstCall({
    toolName: "browser",
    toolArgs: { action: "open", url: "https://mail.google.com" },
    priorToolCallsInRun: [
      { name: "browser", args: { action: "open", url: "https://mail.google.com" } },
    ],
    userMessage: "check my emails",
  });
  assert.equal(result.intercept, false);
});

/* ------------------------------------------------------------------ */
/*  Tier 4 two-step: web-fetch-first rule                              */
/* ------------------------------------------------------------------ */

test("two-step: pin grounding done but no web fetch on this host → intercept (web fetch first)", () => {
  const result = shouldInterceptBrowserFirstCall({
    toolName: "browser",
    toolArgs: { action: "open", url: "https://www.backcountry.com/rc/double-cash-back-weekend" },
    priorToolCallsInRun: [
      { name: "exec", args: { command: "pin raw gmail recent --hours 72" } },
      { name: "memory_search", args: { query: "outdoor gear" } },
    ],
    userMessage: "tell me about this Backcountry promo",
  });
  assert.equal(result.intercept, true);
  assert.match(result.reminder ?? "", /two-step|web fetch FIRST|pin web fetch/i);
});

test("two-step: prior pin web fetch on same host → do not intercept", () => {
  const result = shouldInterceptBrowserFirstCall({
    toolName: "browser",
    toolArgs: { action: "open", url: "https://www.backcountry.com/rc/double-cash-back-weekend" },
    priorToolCallsInRun: [
      { name: "exec", args: { command: "pin raw gmail recent --hours 72" } },
      { name: "exec", args: { command: 'pin web fetch --url "https://www.backcountry.com/rc/double-cash-back-weekend"' } },
    ],
    userMessage: "tell me about this Backcountry promo",
  });
  assert.equal(result.intercept, false);
});

test("two-step: prior pin web fetch on different host → still intercept", () => {
  const result = shouldInterceptBrowserFirstCall({
    toolName: "browser",
    toolArgs: { action: "open", url: "https://www.backcountry.com/page" },
    priorToolCallsInRun: [
      { name: "exec", args: { command: "pin raw gmail recent" } },
      { name: "exec", args: { command: "pin web fetch --url https://forbes.com/article" } },
    ],
    userMessage: "show me the deal",
  });
  assert.equal(result.intercept, true);
  assert.match(result.reminder ?? "", /two-step|FIRST/i);
});

test("two-step: pin web fetch with --url= form (no space) → recognized as same host", () => {
  const result = shouldInterceptBrowserFirstCall({
    toolName: "browser",
    toolArgs: { action: "open", url: "https://example.com/p" },
    priorToolCallsInRun: [
      { name: "exec", args: { command: "pin raw gmail recent" } },
      { name: "exec", args: { command: "pin web fetch --url=https://example.com/q" } },
    ],
    userMessage: "look at this",
  });
  assert.equal(result.intercept, false);
});

test("two-step: browser open with no url → do not apply web-fetch rule (rule 1 still applies)", () => {
  // Rule 2 needs a URL to compare hosts. With no URL, just falls through to no intercept
  // (rule 1 already passed because pin grounding was done).
  const result = shouldInterceptBrowserFirstCall({
    toolName: "browser",
    toolArgs: { action: "open" },
    priorToolCallsInRun: [
      { name: "exec", args: { command: "pin raw gmail recent" } },
    ],
    userMessage: "open it",
  });
  assert.equal(result.intercept, false);
});

test("two-step: http:// (non-https) url → do not apply web-fetch rule", () => {
  // pin web fetch only handles https; we don't push agent toward an http
  // fetch that would also fail. Just let browser through.
  const result = shouldInterceptBrowserFirstCall({
    toolName: "browser",
    toolArgs: { action: "open", url: "http://example.com" },
    priorToolCallsInRun: [
      { name: "exec", args: { command: "pin raw gmail recent" } },
    ],
    userMessage: "open it",
  });
  assert.equal(result.intercept, false);
});

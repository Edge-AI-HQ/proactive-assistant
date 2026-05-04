import test from 'node:test';
import assert from 'node:assert/strict';
import { buildChatPrompt, OPENCLAW_CACHE_BOUNDARY, type ChatCardContext } from './chat.ts';

const baseCard: ChatCardContext = {
  title: 'Reply to Andy',
  summary: 'Andy needs an answer about Tuesday',
  primaryAction: { label: 'Reply', type: 'confirm' },
  urgency: 0.5,
};

/* ------------------------------------------------------------------ */
/*  Tier 1-4 policy presence                                           */
/* ------------------------------------------------------------------ */

test('chat prompt declares the four tiers explicitly', () => {
  const { systemPrompt } = buildChatPrompt({});
  assert.match(systemPrompt, /Tier 1.*Local read/);
  assert.match(systemPrompt, /Tier 2.*Composio read/);
  assert.match(systemPrompt, /Tier 3.*Composio write/);
  assert.match(systemPrompt, /Tier 4.*Browser/);
});

test('chat prompt mentions the pin subcommand prefixes per tier', () => {
  const { systemPrompt } = buildChatPrompt({});
  assert.match(systemPrompt, /pin raw/);
  assert.match(systemPrompt, /pin signals/);
  assert.match(systemPrompt, /pin personal exec/);
  assert.match(systemPrompt, /pin web fetch/);
});

test('chat prompt frames browser as last-resort', () => {
  const { systemPrompt } = buildChatPrompt({});
  assert.match(systemPrompt, /LAST-RESORT|Last-resort/);
  // And it tells the agent NOT to use browser for the obvious cases:
  assert.match(systemPrompt, /NEVER use browser for Gmail/);
});

/* ------------------------------------------------------------------ */
/*  Tier 4 two-step (web fetch → browser) rule                         */
/* ------------------------------------------------------------------ */

test('Tier 4 is framed as a two-step (web fetch first, browser as upgrade)', () => {
  const { systemPrompt } = buildChatPrompt({});
  // Two-step language must be there
  assert.match(systemPrompt, /two-step/i);
  // Step 1 is web fetch, mandatory
  assert.match(systemPrompt, /Step 1.*pin web fetch/i);
  assert.match(systemPrompt, /mandatory|EVERY https URL/i);
  // Step 2 is browser, conditional on specific failures
  assert.match(systemPrompt, /Step 2.*browser/i);
  // Failure modes the agent should look for
  assert.match(systemPrompt, /login wall|401|403/);
  assert.match(systemPrompt, /SPA shell|JS-only/i);
});

test('Tier 4 demands evidence-cited upgrade from web fetch to browser', () => {
  const { systemPrompt } = buildChatPrompt({});
  // Agent must justify the browser upgrade with concrete fetch evidence
  assert.match(systemPrompt, /Cite.*fetch failure|fetch.*evidence/i);
  assert.match(systemPrompt, /Don't open browser on a hunch|hunch/i);
});

test('routing examples push web fetch first for any https URL', () => {
  const { systemPrompt } = buildChatPrompt({});
  // The "open <url>" example should redirect to web fetch first, not browser
  assert.match(systemPrompt, /open <url>.*pin web fetch/i);
  // Public store / promo example should also go through web fetch first
  assert.match(systemPrompt, /store|promo|sale|pricing/i);
});

/* ------------------------------------------------------------------ */
/*  Side-effect rules                                                  */
/* ------------------------------------------------------------------ */

test('chat prompt explains the verb-based side-effect gate', () => {
  const { systemPrompt } = buildChatPrompt({});
  assert.match(systemPrompt, /--allow-side-effect=true/);
  assert.match(systemPrompt, /SEND.*CREATE.*POST.*UPDATE.*DELETE/);
});

test('chat prompt blacklists GMAIL_SEND_EMAIL with the draft chain', () => {
  const { systemPrompt } = buildChatPrompt({});
  assert.match(systemPrompt, /GMAIL_SEND_EMAIL/);
  assert.match(systemPrompt, /GMAIL_CREATE_EMAIL_DRAFT/);
  assert.match(systemPrompt, /GMAIL_SEND_DRAFT/);
});

test('chat prompt requires draft-before-send approval loop', () => {
  const { systemPrompt } = buildChatPrompt({});
  // Some shape of "draft → user OK → send" must appear
  assert.match(systemPrompt, /Draft|draft/);
  assert.match(systemPrompt, /OK|approve|confirm/);
});

test('chat prompt warns about high-risk verbs (DELETE / TRANSFER / CHARGE)', () => {
  const { systemPrompt } = buildChatPrompt({});
  assert.match(systemPrompt, /DELETE/);
  assert.match(systemPrompt, /TRANSFER|CHARGE/);
  // It should tell the agent to stop and ask, not proceed silently
  assert.match(systemPrompt, /stop and ask|ask the user explicitly/i);
});

/* ------------------------------------------------------------------ */
/*  Routing examples                                                   */
/* ------------------------------------------------------------------ */

test('chat prompt ships at least 5 concrete user-asks routing examples', () => {
  const { systemPrompt } = buildChatPrompt({});
  const matches = systemPrompt.match(/user asks "/g) ?? [];
  assert.ok(matches.length >= 5, `expected ≥5 routing examples, got ${matches.length}`);
});

/* ------------------------------------------------------------------ */
/*  Cache boundary stability                                           */
/* ------------------------------------------------------------------ */

test('cache boundary marker appears exactly once', () => {
  const { systemPrompt } = buildChatPrompt({ card: baseCard });
  const occurrences = systemPrompt.split(OPENCLAW_CACHE_BOUNDARY).length - 1;
  assert.equal(occurrences, 1, `boundary must appear exactly once, got ${occurrences}`);
});

test('stable prefix is identical across different cards / learned-skills / no-card', () => {
  const promptA = buildChatPrompt({ card: baseCard }).systemPrompt;
  const promptB = buildChatPrompt({
    card: { ...baseCard, title: 'Different card', summary: 'Different summary' },
  }).systemPrompt;
  const promptC = buildChatPrompt({
    card: baseCard,
    learnedSkillsSection: '## Learned Skill\n- prefer morning meetings',
  }).systemPrompt;
  const promptD = buildChatPrompt({}).systemPrompt;

  const prefixA = promptA.split(OPENCLAW_CACHE_BOUNDARY)[0];
  const prefixB = promptB.split(OPENCLAW_CACHE_BOUNDARY)[0];
  const prefixC = promptC.split(OPENCLAW_CACHE_BOUNDARY)[0];
  const prefixD = promptD.split(OPENCLAW_CACHE_BOUNDARY)[0];

  assert.equal(prefixA, prefixB, 'prefix differs across card titles');
  assert.equal(prefixA, prefixC, 'prefix differs when learnedSkillsSection added');
  assert.equal(prefixA, prefixD, 'prefix differs between card / no-card');
});

test('volatile suffix carries card_context and learned skills, not prefix', () => {
  const { systemPrompt } = buildChatPrompt({
    card: baseCard,
    learnedSkillsSection: '## Learned\n- prefer morning',
  });
  const [prefix, suffix] = systemPrompt.split(OPENCLAW_CACHE_BOUNDARY);
  assert.equal(prefix.includes(baseCard.title), false, 'card title leaked into prefix');
  assert.equal(prefix.includes('prefer morning'), false, 'learned skill leaked into prefix');
  assert.match(suffix, new RegExp(baseCard.title));
  assert.match(suffix, /prefer morning/);
});

test('rawCardContext fallback appears in the volatile suffix only', () => {
  const { systemPrompt } = buildChatPrompt({
    rawCardContext: 'Bare-string card context: open the Gmail thread for Sarah',
  });
  const [prefix, suffix] = systemPrompt.split(OPENCLAW_CACHE_BOUNDARY);
  assert.equal(prefix.includes('Bare-string'), false);
  assert.match(suffix, /Bare-string card context/);
});

/* ------------------------------------------------------------------ */
/*  First-message behavior                                             */
/* ------------------------------------------------------------------ */

test('plain chat (no card, no rawCardContext) returns empty firstMessage', () => {
  const { firstMessage } = buildChatPrompt({});
  assert.equal(firstMessage, '');
});

test('high-urgency confirm card asks agent to execute immediately', () => {
  const { firstMessage } = buildChatPrompt({
    card: { ...baseCard, urgency: 0.85 },
  });
  assert.match(firstMessage, /wants to proceed|Execute/);
});

test('lower-urgency confirm card asks agent to confirm first', () => {
  const { firstMessage } = buildChatPrompt({
    card: { ...baseCard, urgency: 0.3 },
  });
  assert.match(firstMessage, /Confirm details briefly/);
});

test('non-confirm primaryAction triggers conversational exploration', () => {
  const { firstMessage } = buildChatPrompt({
    card: {
      ...baseCard,
      primaryAction: { label: 'Adjust', type: 'modify' },
    },
  });
  assert.match(firstMessage, /Help them with/);
});

/* ------------------------------------------------------------------ */
/*  source_kind hint in firstMessage                                   */
/* ------------------------------------------------------------------ */

test('firstMessage hint points the agent at matching pin Tier 1 paths', () => {
  const { firstMessage } = buildChatPrompt({
    card: {
      ...baseCard,
      sources: [
        "gmail:thread_id=abc 'Re: Tuesday'",
        "memory:topic:scheduling 'prefers afternoon'",
      ],
    },
  });
  assert.match(firstMessage, /Sources: gmail, memory/);
  assert.match(firstMessage, /pin raw gmail/);
  assert.match(firstMessage, /pin memory/);
});

test('firstMessage de-duplicates source kinds', () => {
  const { firstMessage } = buildChatPrompt({
    card: {
      ...baseCard,
      sources: ["gmail:a", "gmail:b", "gmail:c"],
    },
  });
  // "gmail" should appear once in the Sources list (not gmail, gmail, gmail)
  const m = firstMessage.match(/Sources: ([^.]+)\./);
  assert.ok(m, 'expected Sources: line');
  assert.equal(m![1].trim(), 'gmail');
});

test('firstMessage omits hint when sources are absent', () => {
  const { firstMessage } = buildChatPrompt({ card: baseCard });
  assert.equal(firstMessage.includes('Sources:'), false);
});

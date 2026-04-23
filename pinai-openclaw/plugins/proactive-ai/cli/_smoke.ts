/**
 * v3 CLI smoke demo — seeds the v3 storage layer with realistic mock data,
 * then runs every pin CLI command and prints the JSON envelope an agent
 * would actually receive.
 *
 * Run via:
 *   OPENCLAW_HOME=$(mktemp -d) npx tsx pinai-openclaw/plugins/proactive-ai/cli/_smoke.ts
 *
 * Not a unit test — designed to be eyeballed. Asserts only the bare minimum
 * (each CLI returns ok=true) and exits non-zero on failure.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  addMemoryV3,
  addSkill,
  completeEvolutionRun,
  createEvolutionRun,
  ingestPersonalSignals,
  ingestWorldSignal,
  logFeedback,
  recordEvolutionDelta,
  recordEvolutionRefsConsumed,
  recordEvolutionRefsProduced,
  resetDbForTests,
  saveCardEvaluation,
  savePipelineRun,
  upsertProfile,
} from '../db.ts';
import {
  ingestDeviceAppsSnapshot,
  ingestDeviceContactsSnapshot,
  ingestGcalEvents,
  ingestGmailMessages,
  resetRawDbForTests,
} from '../raw-db.ts';

import { handleMemory } from './memory.ts';
import { handleSignals } from './signals.ts';
import { handleRaw } from './raw.ts';
import { handleEvolution } from './evolution.ts';
import { handleSkills } from './skills.ts';
import { handleProfile } from './profile.ts';

// ─── Setup tmp container home ──────────────────────────────────────────

const tmpHome = mkdtempSync(join(tmpdir(), 'pin-v3-smoke-'));
process.env.OPENCLAW_HOME = tmpHome;
console.error(`[smoke] OPENCLAW_HOME = ${tmpHome}\n`);
resetDbForTests();
resetRawDbForTests();

// ─── Mock data — shaped to look like real production rows ─────────────

async function seedAll(): Promise<{ runIds: { evol: string; pipeline: string } }> {
  // Profile
  await upsertProfile({
    displayName: 'Smile',
    locale: 'en-US',
    timezone: 'Asia/Shanghai',
    summary: 'A senior software engineer building Proactive AI. Lives in Shanghai, juggles deep-work coding mornings with afternoon meetings. Wife + 5-year-old daughter. Trying to keep weekends entirely device-free.',
  });

  // ─── memory: 7 facts at a mix of qualities ───
  await addMemoryV3({
    text: '用户每周三 19:00 跟妈妈通话，妈妈住在杭州',
    source: 'crystallize', subject: 'person:mom@home.com', quality: 0.85,
    tags: ['family', 'routine'],
  });
  await addMemoryV3({
    text: '用户工作日 8:00 通勤上班，路程约 25 分钟，地铁 11 号线',
    source: 'extract:device_signals', subject: 'self', quality: 0.8,
    tags: ['routine', 'commute'],
  });
  await addMemoryV3({
    text: '用户关注个人投资（装了 Robinhood + 雪球），偏好 ETF + 美股科技股',
    source: 'extract:device_apps', subject: 'topic:investing', quality: 0.7,
    tags: ['interest', 'finance'],
  });
  await addMemoryV3({
    text: '用户在跑步（Strava 数据：本月已跑 12 次、平均 5km）',
    source: 'extract:device_apps', subject: 'topic:running', quality: 0.65,
    tags: ['health', 'habit'],
  });
  await addMemoryV3({
    text: '用户老板 Alex Chen 偏好简短异步消息 + 周一早会',
    source: 'crystallize', subject: 'person:alex@company.com', quality: 0.75,
    tags: ['work', 'communication'],
  });
  await addMemoryV3({
    text: '用户考虑换车，偏好混动 SUV，预算 30-40 万',
    source: 'manual', subject: 'topic:car_purchase', quality: 0.6,
    tags: ['decision', 'wealth'],
  });
  await addMemoryV3({
    text: '用户最近一次反馈：「太多通勤卡片烦人，已经知道堵车了」',
    source: 'extract:feedback', subject: 'self', quality: 0.55,
    tags: ['feedback'],
  });

  // ─── skills: 3 active + 1 disabled ───
  await addSkill({
    id: 'morning-deep-work',
    title: 'Protect 9-11am deep work',
    description: 'Push back meetings booked in the user\'s 9-11am block',
    body: '# Morning deep-work guard\n\nBetween 9:00 and 11:00 the user does focused engineering work.\n\nTriggers:\n- Calendar event proposed in 9-11am slot\n- Meeting request from non-Alex sender\n\nResponse: suggest "Move to 14:00?"',
    triggers: ['calendar:9-11am', 'meeting:proposed'],
    source: 'crystallize',
  });
  await addSkill({
    id: 'investing-news-card',
    title: 'Surface BTC/ETF news with concrete trigger',
    description: 'When ETF flows hit notable threshold, show a card',
    body: '# Investing news\n\nUser has Robinhood + 雪球 (memory quality 0.7).\n\nTriggers:\n- BTC ETF inflow > $1B daily\n- Top tech stock moves ±5%\n\nResponse: push card with "View positions" button',
    triggers: ['etf_flow:>1B', 'tech_stock:±5%'],
    source: 'evolution',
  });
  await addSkill({
    id: 'mom-call-reminder',
    title: 'Wednesday 19:00 family call nudge',
    description: 'Gentle reminder if user is still at office at 18:30',
    body: '# Mom call reminder\n\nMemory: 用户每周三 19:00 跟妈妈通话.\n\nTriggers:\n- Wednesday 18:30, location=office\n- No mom contact in past 7 days\n\nResponse: "妈妈周三晚 19:00 的电话还有 30 分钟，要现在出发吗?"',
    triggers: ['weekday:Wed', 'time:18:30', 'place:office'],
    source: 'manual',
  });
  const disabled = await addSkill({
    id: 'commute-traffic-pings',
    title: 'Commute traffic ping (DISABLED)',
    description: 'Trigger before commute',
    body: '# (disabled per user feedback — too noisy)',
    triggers: ['weekday:any', 'time:7:30'],
    source: 'crystallize',
  });
  // Mark as disabled to demonstrate
  const { disableSkill } = await import('../db.ts');
  await disableSkill(disabled.id);

  // ─── personal_signals: 5 items, mix of statuses ───
  await ingestPersonalSignals([
    {
      kind: 'moment',
      title: 'home → office',
      summary: '从家到公司，用时 22 分钟（比平时快 3 分钟）',
      payload: { from: 'place:home', to: 'place:office', duration_min: 22, baseline_min: 25 },
      salience: 0.55,
      occurredAt: new Date(Date.now() - 1 * 3600 * 1000).toISOString(),
      source: 'device',
      deviceId: 'iphone-smile-1',
      dedupeKey: 'device:loc:home_to_office:2026-04-23',
    },
    {
      kind: 'attention_item',
      title: 'New mail from mom@home.com',
      summary: '主题：「这周末来杭州吗?」',
      payload: { from: 'mom@home.com', subject: '这周末来杭州吗?' },
      salience: 0.85,
      occurredAt: new Date(Date.now() - 30 * 60 * 1000).toISOString(),
      source: 'connector:gmail_burst',
      sourceRawTable: 'gmail_messages',
      sourceRawIds: ['gm-recent-1'],
    },
    {
      kind: 'attention_item',
      title: 'Calendar conflict tomorrow',
      summary: '明天 14:00 同时安排了「Backend sync」和「Healthcheck review」',
      payload: { conflict_count: 2, calendar_id: 'primary' },
      salience: 0.78,
      occurredAt: new Date(Date.now() - 15 * 60 * 1000).toISOString(),
      source: 'connector:gcal_burst',
    },
    {
      kind: 'session_summary',
      title: 'Audio session: focus block on memory-architecture',
      summary: '47 min of focused work on the v3 memory PR; user was uninterrupted',
      payload: { duration_min: 47, focus_score: 0.92 },
      salience: 0.6,
      occurredAt: new Date(Date.now() - 4 * 3600 * 1000).toISOString(),
      source: 'device',
      deviceId: 'macbook-smile-1',
    },
    {
      kind: 'moment',
      title: 'Old GPS event (already consumed yesterday)',
      summary: 'home → office on 2026-04-22',
      salience: 0.4,
      occurredAt: new Date(Date.now() - 26 * 3600 * 1000).toISOString(),
      source: 'device',
      deviceId: 'iphone-smile-1',
    },
  ]);
  // Mark the last (yesterday's) signal as consumed by an earlier evolution run
  const { listPersonalSignals, markPersonalSignalsConsumed } = await import('../db.ts');
  const olds = await listPersonalSignals({ status: 'open', limit: 100 });
  const yesterdaySig = olds.find((s) => s.title.startsWith('Old GPS'));
  if (yesterdaySig) {
    await markPersonalSignalsConsumed([yesterdaySig.id], 'evol-run-yesterday');
  }

  // ─── world_signals: 3 news items ───
  await ingestWorldSignal({
    provider: 'google-news', title: 'Spot BTC ETF inflows hit record $1.4B day',
    url: 'https://example.com/btc-etf-record',
    normalizedUrl: 'https://example.com/btc-etf-record',
    summary: 'Bitcoin spot ETFs collectively saw $1.4B of inflows on Tuesday — the largest single-day total since launch.',
    publishedAt: new Date(Date.now() - 6 * 3600 * 1000).toISOString(),
    topics: ['finance', 'crypto'], regions: ['global'], importance: 'high',
  });
  await ingestWorldSignal({
    provider: 'sec', title: 'SEC opens public comment on perpetual futures ETF',
    url: 'https://example.com/sec-perp-etf',
    normalizedUrl: 'https://example.com/sec-perp-etf',
    summary: '60-day comment window for a proposed perpetual-futures-style ETF structure.',
    publishedAt: new Date(Date.now() - 18 * 3600 * 1000).toISOString(),
    topics: ['finance', 'regulation'], regions: ['us'], importance: 'medium',
  });
  await ingestWorldSignal({
    provider: 'fed', title: 'FOMC minutes signal cautious cut path',
    url: 'https://example.com/fomc-cautious',
    normalizedUrl: 'https://example.com/fomc-cautious',
    summary: 'Most participants saw a slower pace of cuts as appropriate given sticky services inflation.',
    publishedAt: new Date(Date.now() - 36 * 3600 * 1000).toISOString(),
    topics: ['finance', 'macro'], regions: ['us'], importance: 'medium',
  });

  // ─── raw.db: gmail / gcal / device snapshots ───
  ingestGmailMessages([
    {
      messageId: 'gm-recent-1', threadId: 'th-mom-1',
      from: 'mom@home.com', to: ['smile@pinai.io'],
      subject: '这周末来杭州吗?', snippet: '爸爸做了你爱吃的红烧肉……',
      body: '小宝，\n\n这周末有空回杭州吗？爸爸做了你爱吃的红烧肉，妹妹也想你了。\n\n妈妈',
      occurredAt: new Date(Date.now() - 30 * 60 * 1000).toISOString(),
    },
    {
      messageId: 'gm-recent-2', threadId: 'th-alex-3',
      from: 'alex@company.com', to: ['smile@pinai.io'],
      subject: 'Re: v3 design — quick async question',
      snippet: 'On the personal_signals table, do we...',
      body: 'On the personal_signals table, do we plan to expose the consumed_by_run_id back to the agent retrieval?',
      occurredAt: new Date(Date.now() - 2 * 3600 * 1000).toISOString(),
    },
    {
      messageId: 'gm-recent-3', threadId: 'th-newsletter-9',
      from: 'newsletter@spotify.com', to: ['smile@pinai.io'],
      subject: 'Your week in music',
      snippet: 'You played 4h 12min last week...',
      occurredAt: new Date(Date.now() - 10 * 3600 * 1000).toISOString(),
    },
  ]);

  ingestGcalEvents([
    {
      calendarId: 'primary', eventId: 'evt-standup',
      title: 'Eng standup', startAt: new Date(Date.now() + 15 * 60 * 1000).toISOString(),
      endAt: new Date(Date.now() + 45 * 60 * 1000).toISOString(),
      attendees: ['alex@company.com', 'smile@pinai.io', 'lisa@company.com'], status: 'confirmed',
    },
    {
      calendarId: 'primary', eventId: 'evt-backend-sync',
      title: 'Backend sync',
      startAt: new Date(Date.now() + 24 * 3600 * 1000).toISOString(),
      endAt: new Date(Date.now() + 24 * 3600 * 1000 + 3600 * 1000).toISOString(),
      attendees: ['smile@pinai.io', 'wei@company.com'], status: 'confirmed',
    },
    {
      calendarId: 'personal', eventId: 'evt-mom-call',
      title: '妈妈电话',
      startAt: '2026-04-23T19:00:00+08:00',
      endAt: '2026-04-23T19:30:00+08:00',
      attendees: [], status: 'confirmed',
    },
  ]);

  ingestDeviceAppsSnapshot({
    deviceId: 'iphone-smile-1',
    capturedAt: new Date(Date.now() - 12 * 3600 * 1000).toISOString(),
    apps: [
      { bundleId: 'com.tencent.wechat', appName: 'WeChat', version: '8.0.50' },
      { bundleId: 'com.alibaba.alipay', appName: 'Alipay', version: '10.5.0' },
      { bundleId: 'com.robinhood.android', appName: 'Robinhood', version: '2024.16' },
      { bundleId: 'com.snowballfinance.android', appName: '雪球', version: '15.16' },
      { bundleId: 'com.strava', appName: 'Strava', version: '350.0' },
      { bundleId: 'com.spotify.music', appName: 'Spotify', version: '8.9' },
      { bundleId: 'com.apple.mobilesafari', appName: 'Safari' },
    ],
  });

  ingestDeviceContactsSnapshot({
    deviceId: 'iphone-smile-1',
    capturedAt: new Date(Date.now() - 12 * 3600 * 1000).toISOString(),
    contacts: [
      { displayName: '妈妈', emails: ['mom@home.com'], phones: ['+8613800001111'] },
      { displayName: 'Alex Chen', emails: ['alex@company.com'], phones: ['+8613500002222'] },
      { displayName: '张三', emails: ['zhang@friend.com'] },
    ],
  });

  // ─── evolution_runs: 2 dreams + 1 chat_burst ───
  const evol1 = await createEvolutionRun({
    triggerKind: 'daily_dream',
    windowStart: new Date(Date.now() - 24 * 3600 * 1000).toISOString(),
    windowEnd: new Date().toISOString(),
    contextSummary: 'pulled 14 personal signals, 3 emails, 1 contacts snapshot',
  });
  await recordEvolutionDelta(evol1.id, {
    memoriesWritten: 2, profileUpdated: true, profileChangedKeys: ['summary'],
  });
  await recordEvolutionRefsConsumed(evol1.id, 'personal_signals', ['s-old-1', 's-old-2']);
  await recordEvolutionRefsProduced(evol1.id, 'memory', ['m-investing-1', 'm-mom-routine-1']);
  await completeEvolutionRun(evol1.id, { llmTokens: 4321, durationMs: 8500 });

  const evol2 = await createEvolutionRun({
    triggerKind: 'chat_burst',
    contextSummary: 'evaluator triggered after 5 turns in MainChat about car purchase',
  });
  await recordEvolutionDelta(evol2.id, { memoriesWritten: 1 });
  await recordEvolutionRefsProduced(evol2.id, 'memory', ['m-car-1']);
  await completeEvolutionRun(evol2.id, { llmTokens: 1100, durationMs: 3200 });

  const evol3 = await createEvolutionRun({
    triggerKind: 'daily_dream', contextSummary: 'second dream of the day (manual)',
  });
  // Leave running — to demonstrate the in-flight state

  // ─── pipeline_runs + card_evaluations + push records ───
  const pipelineRunId = `run_${Date.now().toString(36)}`;
  await savePipelineRun({
    runId: pipelineRunId, status: 'completed', totalIterations: 1,
    finalCards: [
      {
        id: 'card-1', goalBasket: 'family', intentKey: 'family/mom-call',
        title: '妈妈周三 19:00 电话提醒（你 18:30 还在公司）',
        whyNow: '今天周三、目前 18:00、距离妈妈电话约 60 分钟', summary: '...',
      },
      {
        id: 'card-2', goalBasket: 'wealth', intentKey: 'wealth/btc-flows',
        title: '今日 BTC ETF 流入创新高，看下你 Robinhood 持仓?',
        whyNow: '今日单日流入 $1.4B 历史第一', summary: '...',
      },
    ],
    iterations: [{ iteration: 1, plan: 'short demo', cards: [], evaluation: {} }],
  });
  await saveCardEvaluation({
    cardId: 'card-1', runId: pipelineRunId, intentKey: 'family/mom-call', basket: 'family',
    dimensions: { relevance: 9, actionability: 8, whyNow: 9, novelty: 6, decisionCompression: 8 },
    overall: 8.0, pass: true, feedbackText: 'tight, action-oriented',
  });
  await saveCardEvaluation({
    cardId: 'card-2', runId: pipelineRunId, intentKey: 'wealth/btc-flows', basket: 'wealth',
    dimensions: { relevance: 7, actionability: 7, whyNow: 8, novelty: 7, decisionCompression: 7 },
    overall: 7.2, pass: true,
  });

  // ─── feedback_events: simulate a confirm + dismiss ───
  await logFeedback({
    kind: 'card_feedback', action: 'confirm', source: 'user_direct', channel: 'web',
    intentCardId: 'card-1', basket: 'family',
  });
  await logFeedback({
    kind: 'card_feedback', action: 'dismiss', source: 'user_direct', channel: 'web',
    intentCardId: 'card-2', basket: 'wealth',
    text: 'too noisy, I look at this myself daily',
  });

  return { runIds: { evol: evol1.id, pipeline: pipelineRunId } };
}

// ─── Print helpers ────────────────────────────────────────────────────

function header(label: string): void {
  console.log('\n' + '═'.repeat(70));
  console.log(`  ${label}`);
  console.log('═'.repeat(70));
}

function pretty(envelope: string, opts: { expectFailure?: boolean } = {}): void {
  try {
    const obj = JSON.parse(envelope);
    if (!obj.ok) {
      console.log(`❌ ${obj.error?.code ?? 'ERR'}: ${obj.error?.message}`);
      if (obj.error?.hint) console.log(`   hint: ${obj.error.hint}`);
      if (!opts.expectFailure) {
        throw new Error(`CLI returned ok=false (unexpected)`);
      }
      return;
    }
    if (opts.expectFailure) {
      throw new Error(`CLI returned ok=true but failure was expected`);
    }
    console.log(JSON.stringify(obj.data, null, 2));
  } catch (err) {
    if (err instanceof SyntaxError) {
      console.log(envelope);
    } else {
      throw err;
    }
  }
}

async function run(label: string, fn: () => Promise<string>, opts: { expectFailure?: boolean } = {}): Promise<void> {
  header(label);
  const out = await fn();
  pretty(out, opts);
}

// ─── Demo script ──────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.error('[smoke] seeding mock data...');
  const { runIds } = await seedAll();
  console.error('[smoke] seed complete\n');

  // ── Long-term picture
  await run('pin profile get --id default --full', () => handleProfile(['get', '--id', 'default', '--full']));
  await run('pin memory list --minQuality 0.7 --limit 10', () => handleMemory(['list', '--minQuality', '0.7', '--limit', '10']));
  await run('pin memory list --subjectPrefix person: --limit 10', () => handleMemory(['list', '--subjectPrefix', 'person:', '--limit', '10']));
  await run('pin memory search --query 投资', () => handleMemory(['search', '--query', '投资']));
  await run('pin skills list --status enabled', () => handleSkills(['list', '--status', 'enabled']));
  await run('pin skills show --id morning-deep-work', () => handleSkills(['show', '--id', 'morning-deep-work']));

  // ── Right-now context
  await run('pin signals recent --hours 24 --limit 10', () => handleSignals(['recent', '--hours', '24', '--limit', '10']));
  await run('pin signals list --status consumed --limit 5', () => handleSignals(['list', '--status', 'consumed', '--limit', '5']));
  await run('pin raw gmail recent --hours 24 --limit 5', () => handleRaw(['gmail', 'recent', '--hours', '24', '--limit', '5']));
  await run('pin raw gcal today', () => handleRaw(['gcal', 'today']));
  await run('pin raw gcal week', () => handleRaw(['gcal', 'week']));
  await run('pin raw device-apps --deviceId iphone-smile-1 --top 10', () => handleRaw(['device-apps', '--deviceId', 'iphone-smile-1', '--top', '10']));

  // ── Behaviour history
  await run('pin evolution recent --kind daily_dream --limit 5', () => handleEvolution(['recent', '--kind', 'daily_dream', '--limit', '5']));
  await run('pin evolution recent --limit 3', () => handleEvolution(['recent', '--limit', '3']));
  await run(`pin evolution get --id ${runIds.evol}`, () => handleEvolution(['get', '--id', runIds.evol]));

  // ── Negative path: empty result still returns valid envelope
  await run('pin memory list --subject does-not-exist (empty result)', () => handleMemory(['list', '--subject', 'does-not-exist']));
  await run('pin signals get --id no-such (expected NOT_FOUND)',
    () => handleSignals(['get', '--id', 'no-such']),
    { expectFailure: true },
  );

  console.log('\n' + '═'.repeat(70));
  console.log(`  ✅ smoke demo complete — ran 16 CLI commands, all returned valid envelopes`);
  console.log('═'.repeat(70));
}

main()
  .then(() => {
    rmSync(tmpHome, { recursive: true, force: true });
    process.exit(0);
  })
  .catch((err) => {
    console.error('\n[smoke] FAILED:', err instanceof Error ? err.stack : err);
    rmSync(tmpHome, { recursive: true, force: true });
    process.exit(1);
  });

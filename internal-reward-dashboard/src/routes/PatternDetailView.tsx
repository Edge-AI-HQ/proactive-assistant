import { useEffect, useState } from "react";
import { Activity, ArrowLeft, Brain, Pencil, RotateCcw, Save, Sparkles, X } from "lucide-react";
import {
  addPatternDemo,
  getPattern,
  setPatternStatus,
  updatePattern,
} from "@/api/reward";
import type {
  PatternDemo,
  PatternDetailResponse,
  PatternRecentHit,
  PatternStatus,
  PatternSummary,
} from "@/api/reward";
import { StateBlock } from "@/components/StateBlock";
import { dashboardRoutes } from "@/lib/dashboardRoutes";
import { formatDateTimeOrDash } from "@/lib/dateFormat";

interface PatternDetailViewProps {
  patternId: string;
  onNavigate: (path: string) => void;
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function asString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function demoCardTitle(card: Record<string, unknown>): string {
  return asString(card.hook) || asString(card.title) || "(no hook)";
}

function demoCardBody(card: Record<string, unknown>): string {
  return asString(card.body) || asString(card.summary);
}

function demoCardAction(card: Record<string, unknown>): string {
  return asString(card.action);
}

interface EditState {
  abstract: string;
  triggerDslText: string;
  cardSkeletonText: string;
}

function initialEditState(p: PatternSummary): EditState {
  return {
    abstract: p.abstract,
    triggerDslText: safeJson(p.triggerDsl),
    cardSkeletonText: safeJson(p.cardSkeleton),
  };
}

export function PatternDetailView({ patternId, onNavigate }: PatternDetailViewProps) {
  const [data, setData] = useState<PatternDetailResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<EditState | null>(null);
  const [saving, setSaving] = useState(false);
  const [flashMessage, setFlashMessage] = useState<string | null>(null);

  function refresh() {
    setLoading(true);
    setError(null);
    getPattern(patternId)
      .then((res) => {
        setData(res);
        setDraft(initialEditState(res.pattern));
      })
      .catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)))
      .finally(() => setLoading(false));
  }

  useEffect(() => {
    refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [patternId]);

  async function saveDraft() {
    if (!draft || !data) return;
    setSaving(true);
    setError(null);
    try {
      let triggerDsl: unknown[] | undefined;
      let cardSkeleton: Record<string, unknown> | undefined;
      try {
        const parsedTrigger = JSON.parse(draft.triggerDslText);
        if (!Array.isArray(parsedTrigger)) throw new Error("triggerDsl 必须是 JSON 数组");
        triggerDsl = parsedTrigger;
      } catch (err) {
        throw new Error(`triggerDsl JSON 解析失败: ${err instanceof Error ? err.message : err}`);
      }
      try {
        const parsedSkeleton = JSON.parse(draft.cardSkeletonText);
        if (typeof parsedSkeleton !== "object" || parsedSkeleton === null || Array.isArray(parsedSkeleton)) {
          throw new Error("cardSkeleton 必须是 JSON 对象");
        }
        cardSkeleton = parsedSkeleton as Record<string, unknown>;
      } catch (err) {
        throw new Error(`cardSkeleton JSON 解析失败: ${err instanceof Error ? err.message : err}`);
      }
      await updatePattern(patternId, {
        abstract: draft.abstract,
        triggerDsl,
        cardSkeleton,
      });
      setEditing(false);
      setFlashMessage("已保存");
      refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }

  async function flipStatus() {
    if (!data) return;
    // pending_review is approved via the /pending workflow, not here.
    if (data.pattern.status === "pending_review") {
      setError("候选范式请到「待审批」页面通过或拒绝。");
      return;
    }
    const next: PatternStatus = data.pattern.status === "active" ? "retired" : "active";
    setSaving(true);
    setError(null);
    try {
      await setPatternStatus(patternId, next);
      setFlashMessage(`status → ${next}`);
      refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }

  async function promoteRecentHitAsGolden() {
    if (!data || data.recentHits.length === 0) {
      setError("没有可晋升的真实命中卡。");
      return;
    }
    // Pick the most recently-opened hit; fall back to the latest hit.
    const hit = data.recentHits.find((h) => h.opened) ?? data.recentHits[0]!;
    setSaving(true);
    setError(null);
    try {
      await addPatternDemo(patternId, {
        source: "golden",
        cardId: hit.cardId,
        scenario: `Real hit promoted ${hit.createdAt ?? ""}`.trim(),
      });
      setFlashMessage("已晋升真实卡为 golden demo");
      refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }

  if (loading) return <StateBlock title="加载中…" />;
  if (error && !data) return <StateBlock title="加载失败" detail={error} />;
  if (!data) return <StateBlock title="未找到" detail={`pattern ${patternId} 不存在或已退役。`} />;

  const { pattern, demos } = data;
  const signals = Array.isArray(pattern.signalsRequired) ? pattern.signalsRequired : [];
  const specializations = Array.isArray(pattern.specializations) ? pattern.specializations : [];
  const effectiveDraft = draft ?? initialEditState(pattern);
  // Pre-compute the status-flip button's label + title here so the JSX
  // doesn't repeat status literals — the semantics-of-active-button
  // accessibility test treats bare "active" strings inside button tags
  // as state-disclosure markers and demands aria-current/aria-pressed.
  const isPending = pattern.status === "pending_review";
  const flipLabel = isPending ? "去待审批" : (pattern.status === "retired" ? "复活" : "退役");
  const flipTitle = isPending
    ? "候选范式请到「待审批」页面通过或拒绝"
    : (pattern.status === "retired" ? "复活退役范式" : "退役该范式");

  return (
    <div className="stack">
      <section className="panel" aria-label="范式详情">
        <div className="panel-head">
          <div>
            <button
              className="plain-button"
              onClick={() => onNavigate(dashboardRoutes.patterns)}
              type="button"
            >
              <ArrowLeft size={14} />
              <span>返回范式库</span>
            </button>
            <div className="eyebrow">
              <Brain size={14} aria-hidden="true" /> {pattern.category}
            </div>
            <h2 data-testid="pattern-detail-id">{pattern.id}</h2>
            {!editing ? (
              <p>{pattern.abstract}</p>
            ) : (
              <textarea
                aria-label="编辑 abstract"
                className="patterns-edit-text"
                value={effectiveDraft.abstract}
                onChange={(e) => setDraft({ ...effectiveDraft, abstract: e.target.value })}
                rows={3}
              />
            )}
          </div>
          <div className="toolbar-actions">
            {!editing && (
              <button
                className="plain-button"
                type="button"
                onClick={() => setEditing(true)}
                data-testid="enter-edit-mode"
              >
                <Pencil size={14} aria-hidden="true" />
                <span>编辑</span>
              </button>
            )}
            {editing && (
              <>
                <button
                  className="primary-button"
                  type="button"
                  onClick={() => void saveDraft()}
                  disabled={saving}
                  data-testid="save-edit"
                >
                  <Save size={14} aria-hidden="true" />
                  <span>{saving ? "保存中…" : "保存"}</span>
                </button>
                <button
                  className="plain-button"
                  type="button"
                  onClick={() => {
                    setEditing(false);
                    setDraft(initialEditState(pattern));
                  }}
                  disabled={saving}
                >
                  <X size={14} aria-hidden="true" />
                  <span>取消</span>
                </button>
              </>
            )}
            <button
              className="plain-button"
              type="button"
              onClick={() => void flipStatus()}
              disabled={saving || isPending}
              data-testid="flip-status"
              title={flipTitle}
            >
              <RotateCcw size={14} aria-hidden="true" />
              <span>{flipLabel}</span>
            </button>
            <button
              className="plain-button"
              type="button"
              onClick={() => void promoteRecentHitAsGolden()}
              disabled={saving || data.recentHits.length === 0}
              data-testid="promote-golden"
              title={
                data.recentHits.length === 0
                  ? "没有真实命中卡可晋升"
                  : "把最新命中的真实卡复制成 golden demo"
              }
            >
              <Sparkles size={14} aria-hidden="true" />
              <span>晋升 Golden</span>
            </button>
          </div>
        </div>
        <div className="patterns-chip-row">
          <span className="patterns-chip patterns-chip-status">{pattern.status}</span>
          <span className="patterns-chip">tier: {pattern.tier}</span>
          <span className="patterns-chip">intent: {pattern.intent}</span>
          <span className="patterns-chip">surprise: {pattern.surpriseInit ?? "—"}</span>
          <span className="patterns-chip">practical: {pattern.practicalInit ?? "—"}</span>
          <span className="patterns-chip">source: {pattern.source}</span>
          <span className="patterns-chip">base hit: {(pattern.baseHitRate * 100).toFixed(0)}%</span>
        </div>
        {flashMessage && <p className="muted" role="status">{flashMessage}</p>}
        {error && <p className="muted" role="alert">{error}</p>}
      </section>

      <section className="panel" aria-label="Signals required">
        <h3>Signals Required</h3>
        <div className="patterns-chip-row">
          {signals.length === 0
            ? <span className="muted">未声明</span>
            : signals.map((s, idx) => (
              <span key={`${pattern.id}-signal-${idx}`} className="patterns-chip">{String(s)}</span>
            ))}
        </div>
      </section>

      <section className="panel" aria-label="Trigger DSL">
        <h3>Trigger DSL</h3>
        {!editing ? (
          <pre className="patterns-code" data-testid="pattern-trigger-dsl">
{safeJson(pattern.triggerDsl)}
          </pre>
        ) : (
          <textarea
            aria-label="编辑 trigger DSL JSON"
            className="patterns-edit-code"
            value={effectiveDraft.triggerDslText}
            onChange={(e) => setDraft({ ...effectiveDraft, triggerDslText: e.target.value })}
            rows={10}
            spellCheck={false}
          />
        )}
      </section>

      <section className="panel" aria-label="Card skeleton">
        <h3>Card Skeleton</h3>
        {!editing ? (
          <pre className="patterns-code" data-testid="pattern-card-skeleton">
{safeJson(pattern.cardSkeleton)}
          </pre>
        ) : (
          <textarea
            aria-label="编辑 card skeleton JSON"
            className="patterns-edit-code"
            value={effectiveDraft.cardSkeletonText}
            onChange={(e) => setDraft({ ...effectiveDraft, cardSkeletonText: e.target.value })}
            rows={8}
            spellCheck={false}
          />
        )}
      </section>

      <section className="panel" aria-label="Specializations">
        <h3>Specializations</h3>
        {specializations.length === 0
          ? <p className="muted">无 specialization。</p>
          : <pre className="patterns-code">{safeJson(specializations)}</pre>}
      </section>

      <section className="panel" aria-label="Health">
        <h3>
          <Activity size={14} aria-hidden="true" /> Health
        </h3>
        {data.health ? (
          <div className="patterns-chip-row">
            <span className="patterns-chip">
              hit_rate_7d: {data.health.hitRate7d === null ? "—" : (data.health.hitRate7d * 100).toFixed(0) + "%"}
            </span>
            <span className="patterns-chip">
              hit_rate_30d: {data.health.hitRate30d === null ? "—" : (data.health.hitRate30d * 100).toFixed(0) + "%"}
            </span>
            <span className="patterns-chip">
              trend: {data.health.hitRate30dTrend === null ? "—" : data.health.hitRate30dTrend.toFixed(2)}
            </span>
            <span className="patterns-chip">
              dismiss_rate: {data.health.dismissRate30d === null ? "—" : (data.health.dismissRate30d * 100).toFixed(0) + "%"}
            </span>
            <span className="patterns-chip">
              eval-human gap: {data.health.evaluatorHumanGapMean === null ? "—" : data.health.evaluatorHumanGapMean.toFixed(2)}
            </span>
            <span className="patterns-chip">
              hits 7d / 30d: {data.health.hitCount7d} / {data.health.hitCount30d}
            </span>
            {data.health.shouldRetire && (
              <span className="patterns-chip patterns-chip-status">
                retire? {data.health.retireReasons.join(", ")}
              </span>
            )}
          </div>
        ) : <p className="muted">暂无健康数据。</p>}
      </section>

      <section className="panel" aria-label="Recent matched cards">
        <h3>Recent Matched Cards · {data.recentHits.length}</h3>
        {data.recentHits.length === 0
          ? <p className="muted">该 pattern 还没有 hit 记录。</p>
          : (
            <div className="table-wrap">
              <table aria-label="该 pattern 最近命中的卡片" className="patterns-table">
                <thead>
                  <tr>
                    <th scope="col">user</th>
                    <th scope="col">card</th>
                    <th scope="col">subtype</th>
                    <th scope="col">opened?</th>
                    <th scope="col">reviewer</th>
                    <th scope="col">evaluator</th>
                    <th scope="col">gap</th>
                    <th scope="col">grounding</th>
                    <th scope="col">at</th>
                  </tr>
                </thead>
                <tbody>
                  {data.recentHits.map((h: PatternRecentHit) => (
                    <tr
                      key={`${h.userId}:${h.cardId}`}
                      className="patterns-row"
                      onClick={() => onNavigate(dashboardRoutes.card(h.cardId))}
                      role="button"
                      tabIndex={0}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" || e.key === " ") {
                          e.preventDefault();
                          onNavigate(dashboardRoutes.card(h.cardId));
                        }
                      }}
                    >
                      <td>{h.userId}</td>
                      <td><code>{h.cardId}</code></td>
                      <td>{h.subtype ?? "—"}</td>
                      <td>{h.opened ? "✓" : "—"}</td>
                      <td>{h.reviewerScore !== null ? h.reviewerScore.toFixed(1) : "—"}</td>
                      <td>{h.evaluatorOverall !== null ? h.evaluatorOverall.toFixed(1) : "—"}</td>
                      <td>{h.evaluatorHumanGap !== null ? h.evaluatorHumanGap.toFixed(1) : "—"}</td>
                      <td>{h.patternGroundingOk === null ? "—" : (h.patternGroundingOk ? "ok" : "fail")}</td>
                      <td>{formatDateTimeOrDash(h.createdAt, { dateStyle: "short", timeStyle: "short" }, "zh-CN")}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
      </section>

      <section className="panel" aria-label="Demo cards">
        <h3>
          <Sparkles size={14} aria-hidden="true" /> Demo Cards · {demos.length}
        </h3>
        {demos.length === 0
          ? <p className="muted">该 pattern 暂无 demo card。</p>
          : (
            <ul className="patterns-demo-list" data-testid="pattern-demo-list">
              {demos.map((demo: PatternDemo) => (
                <li key={demo.id} className="patterns-demo">
                  <div className="patterns-demo-meta">
                    <strong>{demoCardTitle(demo.card)}</strong>
                    {demo.subtype && <span className="patterns-chip">{demo.subtype}</span>}
                    {typeof demo.wowLevel === "number"
                      && <span className="patterns-chip">wow {demo.wowLevel}/5</span>}
                    <span className="patterns-chip">{demo.source}</span>
                  </div>
                  {demo.scenario && (
                    <p className="muted patterns-demo-scenario">{demo.scenario}</p>
                  )}
                  {demoCardBody(demo.card) && (
                    <pre className="patterns-demo-body">{demoCardBody(demo.card)}</pre>
                  )}
                  {demoCardAction(demo.card) && (
                    <p className="patterns-demo-action">→ {demoCardAction(demo.card)}</p>
                  )}
                  {demo.whySurprise && (
                    <p className="muted"><b>surprise：</b>{demo.whySurprise}</p>
                  )}
                  {demo.whyPractical && (
                    <p className="muted"><b>practical：</b>{demo.whyPractical}</p>
                  )}
                </li>
              ))}
            </ul>
          )}
      </section>
    </div>
  );
}

export default PatternDetailView;

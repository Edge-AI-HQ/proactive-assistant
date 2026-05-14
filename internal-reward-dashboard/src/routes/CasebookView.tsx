import { useEffect, useMemo, useRef, useState } from "react";
import { ChevronLeft, ChevronRight, ClipboardCopy, Download, ExternalLink, GitBranch, ListChecks, RefreshCw, Trash2 } from "lucide-react";
import {
  CASEBOOK_OFFSET_MAX,
  casebookMarkdown,
  cardTitle,
  deleteCasebook,
  listCasebook,
  scoreLabel,
} from "@/api/reward";
import type { CasebookEntry } from "@/api/reward";
import { StateBlock } from "@/components/StateBlock";
import { copyText } from "@/lib/clipboard";
import { finiteCount, formatCount, pageWithinOffsetLimit, totalPagesForOffsetLimit } from "@/lib/count";
import { dashboardRouteDisabledReason, dashboardRoutes, firstDashboardRouteId, hasDashboardRouteId } from "@/lib/dashboardRoutes";
import { formatDateTimeOrDash } from "@/lib/dateFormat";
import { dateRangeOrderError, dayEndIso, dayStartIso } from "@/lib/dateRange";
import { staleMutationRefreshError } from "@/lib/mutationRefresh";
import { shouldWaitForPageReset } from "@/lib/pageReset";
import { normalizePageSize } from "@/lib/pageSize";
import { casebookDeleteErrorMessage } from "@/lib/reviewStatus";
import { finiteScore } from "@/lib/runSummary";
import { REWARD_TEXT_FILTER_MAX_LENGTH, textFilterLengthError } from "@/lib/textFilter";
import { stringList } from "@/lib/traceText";

interface CasebookViewProps {
  onNavigate: (path: string) => void;
}

type LoadOptions = { bubbleError?: boolean };

interface CasebookQueryState {
  basket: string;
  intent: string;
  label: string;
  maxScore: string;
  minEvaluatorGap: string;
  minScore: string;
  offset: number;
  pageSize: number;
  since: string;
  until: string;
}

export function caseGap(item: CasebookEntry): number | null {
  const evaluatorScore = finiteScore(item.snapshot.evaluation?.overall);
  const humanScore = finiteScore(item.scoreSnapshot)
    ?? finiteScore(item.snapshot.rewards?.reviewerReward)
    ?? finiteScore(item.snapshot.rewards?.userReward);
  if (evaluatorScore === null || humanScore === null) return null;
  return evaluatorScore - humanScore;
}

export function caseGapMagnitude(item: CasebookEntry): number | null {
  const gap = caseGap(item);
  return gap === null ? null : Math.abs(gap);
}

function compactDate(value: string): string {
  return formatDateTimeOrDash(value, {
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    month: "2-digit",
  }, "zh-CN");
}

export function casebookSources(item: CasebookEntry): string[] {
  if (Array.isArray(item.snapshot.sources)) return stringList(item.snapshot.sources);
  return stringList(item.snapshot.card?.sources);
}

function firstSource(item: CasebookEntry): string {
  const sources = casebookSources(item);
  const first = sources.find((source) => typeof source === "string" && source.trim());
  return clipDisplayText(first, "没有保存证据引用。", 180);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function casebookItems(value: unknown): CasebookEntry[] {
  return Array.isArray(value)
    ? value.filter((item): item is CasebookEntry => {
        if (!isRecord(item) || !isRecord(item.snapshot)) return false;
        return typeof item.id === "string"
          && typeof item.runId === "string"
          && typeof item.cardId === "string"
          && typeof item.label === "string";
      })
    : [];
}

function clipDisplayText(value: string | null | undefined, fallback: string, limit = 180): string {
  const text = typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
  if (!text) return fallback;
  return text.length <= limit ? text : `${text.slice(0, limit - 1).trim()}...`;
}

const caseLabelText: Record<string, string> = {
  great: "好样本",
  bad: "坏样本",
  surprising: "惊喜",
  generic: "泛化",
  hallucinated: "幻觉",
  duplicate: "重复",
  mistimed: "时机不对",
  weak_source: "证据弱",
};

const negativeLabels = new Set(["bad", "generic", "hallucinated", "duplicate", "mistimed", "weak_source"]);
const pageSizeOptions = [20, 40, 80];
type CasebookLabelTone = "bad" | "good" | "neutral";

export function casebookLabelDisplay(value: unknown): string {
  if (typeof value !== "string") return "未知标签";
  const label = value.trim();
  if (!label) return "未知标签";
  return caseLabelText[label] ?? `未知标签：${clipDisplayText(label, "未知", 80)}`;
}

export function casebookLabelTone(value: unknown): CasebookLabelTone {
  if (typeof value !== "string" || !(value in caseLabelText)) return "neutral";
  return negativeLabels.has(value) ? "bad" : "good";
}

function average(values: Array<number | null>): number | null {
  const nums = values.filter((value): value is number => typeof value === "number" && Number.isFinite(value));
  if (nums.length === 0) return null;
  return nums.reduce((sum, value) => sum + value, 0) / nums.length;
}

function gapLabel(value: number | null): string {
  if (value === null) return "-";
  const text = scoreLabel(value);
  return value > 0 ? `+${text}` : text;
}

function casebookQueryKey(query: CasebookQueryState): string {
  return JSON.stringify(query);
}

export function scoreFilterNumber(value: string): number | undefined {
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  const score = Number(trimmed);
  if (!Number.isFinite(score) || score < 0 || score > 10) return undefined;
  return score;
}

export function casebookScoreFilterError({
  maxScore,
  minEvaluatorGap,
  minScore,
}: Pick<CasebookQueryState, "maxScore" | "minEvaluatorGap" | "minScore">): string | null {
  if (minScore.trim() && scoreFilterNumber(minScore) === undefined) return "最低保存分必须是 0 到 10 之间的数字。";
  if (maxScore.trim() && scoreFilterNumber(maxScore) === undefined) return "最高保存分必须是 0 到 10 之间的数字。";
  if (minEvaluatorGap.trim() && scoreFilterNumber(minEvaluatorGap) === undefined) return "最小评估器分差必须是 0 到 10 之间的数字。";
  const min = scoreFilterNumber(minScore);
  const max = scoreFilterNumber(maxScore);
  if (min !== undefined && max !== undefined && min > max) return "最低保存分不能大于最高保存分。";
  return null;
}

export function casebookFilterError({
  basket = "",
  intent = "",
  maxScore,
  minEvaluatorGap,
  minScore,
  since,
  until,
}: Pick<CasebookQueryState, "maxScore" | "minEvaluatorGap" | "minScore" | "since" | "until">
  & Partial<Pick<CasebookQueryState, "basket" | "intent">>): string | null {
  return casebookScoreFilterError({ maxScore, minEvaluatorGap, minScore })
    ?? textFilterLengthError(basket, "领域筛选")
    ?? textFilterLengthError(intent, "意图筛选")
    ?? dateRangeOrderError(since, until, "样本更新时间");
}

export function casebookMutationCardId(item: Pick<CasebookEntry, "cardId" | "snapshot">): string {
  return firstDashboardRouteId(item.cardId, item.snapshot.card?.id);
}

function isCurrentLoadedQuery(currentQueryKey: string, loadedQueryKey: string | null): boolean {
  return loadedQueryKey !== null && loadedQueryKey === currentQueryKey;
}

export function casebookBlockingError(
  error: string | null,
  hasLoaded: boolean,
  currentQueryKey = "",
  loadedQueryKey: string | null = null,
  filterValidationError: string | null = null,
): boolean {
  void currentQueryKey;
  void loadedQueryKey;
  if (filterValidationError) return false;
  return error !== null && !hasLoaded;
}

export function casebookRefreshErrorText(
  error: string | null,
  hasLoaded: boolean,
  currentQueryKey = "",
  loadedQueryKey: string | null = null,
): string | null {
  if (!error || !hasLoaded) return null;
  if (isCurrentLoadedQuery(currentQueryKey, loadedQueryKey)) {
    return `样本库刷新失败，当前仍显示上一次成功加载的数据：${error}`;
  }
  return `样本库刷新失败，当前筛选还没有成功加载结果：${error}`;
}

export function casebookHideStaleRows(hasLoaded: boolean, currentQueryKey: string, loadedQueryKey: string | null): boolean {
  return hasLoaded && !isCurrentLoadedQuery(currentQueryKey, loadedQueryKey);
}

export function canExportCasebookPage(items: CasebookEntry[], loading: boolean, error: string | null = null): boolean {
  return !loading && error === null && items.length > 0;
}

export function casebookCopyUnavailableMessage(
  loading: boolean,
  error: string | null,
  filterValidationError: string | null,
): string {
  if (filterValidationError) return "当前筛选条件无效，先修正后再复制。";
  if (loading) return "正在读取当前页样本，加载完成后再复制。";
  if (error) return "当前页刷新失败，先重新加载成功后再复制。";
  return "当前页没有可复制样本。";
}

export function casebookTableEmptyMessage(
  loading: boolean,
  changedQueryError: boolean,
  filterValidationError: string | null = null,
): string {
  if (filterValidationError) return "当前筛选条件无效，请先修正。";
  if (loading) return "正在读取样本库";
  if (changedQueryError) return "当前筛选加载失败，请调整筛选后重试。";
  return "当前筛选下没有保存样本。";
}

export function CasebookView({ onNavigate }: CasebookViewProps) {
  const [items, setItems] = useState<CasebookEntry[]>([]);
  const [total, setTotal] = useState(0);
  const [label, setLabel] = useState("");
  const [minScore, setMinScore] = useState("");
  const [maxScore, setMaxScore] = useState("");
  const [basket, setBasket] = useState("");
  const [intent, setIntent] = useState("");
  const [minEvaluatorGap, setMinEvaluatorGap] = useState("");
  const [since, setSince] = useState("");
  const [until, setUntil] = useState("");
  const [pageSize, setPageSize] = useState(20);
  const [page, setPage] = useState(1);
  const [markdownOpen, setMarkdownOpen] = useState(false);
  const [statusMessage, setStatusMessage] = useState<{ kind: "error" | "status"; text: string } | null>(null);
  const [pendingDeleteCardId, setPendingDeleteCardId] = useState<string | null>(null);
  const [deletingCardId, setDeletingCardId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [hasLoaded, setHasLoaded] = useState(false);
  const [loadedQueryKey, setLoadedQueryKey] = useState<string | null>(null);
  const requestSeq = useRef(0);

  const offset = (page - 1) * pageSize;
  const currentFilterKey = casebookQueryKey({
    basket,
    intent,
    label,
    maxScore,
    minEvaluatorGap,
    minScore,
    offset: 0,
    pageSize,
    since,
    until,
  });
  const currentQueryKey = casebookQueryKey({
    basket,
    intent,
    label,
    maxScore,
    minEvaluatorGap,
    minScore,
    offset,
    pageSize,
    since,
    until,
  });
  const previousFilterKey = useRef(currentFilterKey);
  const activeCasebookQueryKeyRef = useRef(currentQueryKey);
  activeCasebookQueryKeyRef.current = currentQueryKey;
  const filterValidationError = casebookFilterError({ basket, intent, maxScore, minEvaluatorGap, minScore, since, until });

  async function load(options: LoadOptions = {}) {
    const requestId = requestSeq.current + 1;
    const requestQueryKey = currentQueryKey;
    requestSeq.current = requestId;
    if (requestQueryKey !== activeCasebookQueryKeyRef.current) {
      if (options.bubbleError) throw staleMutationRefreshError();
      return;
    }
    if (filterValidationError) {
      setLoading(false);
      setError(filterValidationError);
      if (options.bubbleError) throw new Error(filterValidationError);
      return;
    }
    try {
      setLoading(true);
      setError(null);
      const next = await listCasebook({
        label: label || undefined,
        minScore: scoreFilterNumber(minScore),
        maxScore: scoreFilterNumber(maxScore),
        basket: basket || undefined,
        intent: intent || undefined,
        minEvaluatorGap: scoreFilterNumber(minEvaluatorGap),
        since: dayStartIso(since),
        until: dayEndIso(until),
        limit: pageSize,
        offset,
      });
      if (requestQueryKey !== activeCasebookQueryKeyRef.current || requestId !== requestSeq.current) {
        if (options.bubbleError) throw staleMutationRefreshError();
        return;
      }
      const nextItems = casebookItems(next.items);
      const nextTotal = finiteCount(next.total, nextItems.length);
      const nextPage = pageWithinOffsetLimit(page, nextTotal, pageSize, CASEBOOK_OFFSET_MAX);
      if (nextPage !== page) {
        setPage(nextPage);
        return;
      }
      setItems(nextItems);
      setTotal(nextTotal);
      setHasLoaded(true);
      setLoadedQueryKey(requestQueryKey);
      setError(null);
    } catch (err) {
      if (requestQueryKey !== activeCasebookQueryKeyRef.current || requestId !== requestSeq.current) {
        if (options.bubbleError) throw staleMutationRefreshError();
        return;
      }
      if (requestId === requestSeq.current) {
        if (!options.bubbleError) {
          setError(err instanceof Error ? err.message : "加载失败");
        }
        if (options.bubbleError) {
          throw err;
        }
      }
    } finally {
      if (requestQueryKey === activeCasebookQueryKeyRef.current && requestId === requestSeq.current) {
        setLoading(false);
      }
    }
  }

  useEffect(() => {
    setStatusMessage(null);
    setPendingDeleteCardId(null);
    setDeletingCardId(null);
    setMarkdownOpen(false);
  }, [page]);

  useEffect(() => {
    const filterChanged = currentFilterKey !== previousFilterKey.current;
    if (filterChanged) {
      previousFilterKey.current = currentFilterKey;
      setStatusMessage(null);
      setPendingDeleteCardId(null);
      setDeletingCardId(null);
      setMarkdownOpen(false);
      if (shouldWaitForPageReset(filterChanged, page)) {
        setPage(1);
        return;
      }
    }
    void load();
  }, [currentFilterKey, page]);

  const hideStaleRows = casebookHideStaleRows(hasLoaded, currentQueryKey, loadedQueryKey);
  const visibleItems = hideStaleRows ? [] : items;
  const visibleTotal = hideStaleRows ? 0 : total;
  const visibleLoading = loading || (hideStaleRows && error === null);
  const changedQueryError = hideStaleRows && error !== null;
  const markdown = useMemo(() => casebookMarkdown(visibleItems), [visibleItems]);
  const pageNegativeCount = visibleItems.filter((item) => negativeLabels.has(item.label)).length;
  const pagePositiveCount = visibleItems.length - pageNegativeCount;
  const pageAvgScore = average(visibleItems.map((item) => item.scoreSnapshot));
  const pageAvgGap = average(visibleItems.map(caseGapMagnitude));
  const totalPages = totalPagesForOffsetLimit(visibleTotal, pageSize, CASEBOOK_OFFSET_MAX);
  const refreshErrorText = filterValidationError
    ? null
    : casebookRefreshErrorText(error, hasLoaded, currentQueryKey, loadedQueryKey);
  const exportEnabled = canExportCasebookPage(visibleItems, visibleLoading, error);

  async function removeCase(item: CasebookEntry) {
    const mutationCardId = casebookMutationCardId(item);
    const displayTitle = clipDisplayText(cardTitle(item.snapshot.card), "未命名卡片", 160);
    if (!hasDashboardRouteId(mutationCardId)) {
      setStatusMessage({ kind: "error", text: "当前样本缺少卡片 ID，不能移除。" });
      return;
    }
    if (pendingDeleteCardId !== mutationCardId) {
      setPendingDeleteCardId(mutationCardId);
      setStatusMessage({
        kind: "status",
        text: `再次点击“确认移除”会从样本库移除：${displayTitle}。`,
      });
      return;
    }

    const mutationQueryKey = currentQueryKey;
    setDeletingCardId(mutationCardId);
    let deleted = false;
    try {
      await deleteCasebook(mutationCardId);
      deleted = true;
      if (activeCasebookQueryKeyRef.current !== mutationQueryKey) return;
      setPendingDeleteCardId(null);
      await load({ bubbleError: true });
      if (activeCasebookQueryKeyRef.current !== mutationQueryKey) return;
      setStatusMessage({ kind: "status", text: `已从样本库移除：${displayTitle}。` });
    } catch (err) {
      if (activeCasebookQueryKeyRef.current !== mutationQueryKey) return;
      setStatusMessage({
        kind: "error",
        text: casebookDeleteErrorMessage(deleted, err),
      });
    } finally {
      if (activeCasebookQueryKeyRef.current === mutationQueryKey) {
        setDeletingCardId((current) => current === mutationCardId ? null : current);
      }
    }
  }

  async function copyMarkdown() {
    if (!exportEnabled) {
      setStatusMessage({
        kind: "status",
        text: casebookCopyUnavailableMessage(visibleLoading, error, filterValidationError),
      });
      return;
    }
    if (!markdown.trim()) {
      setStatusMessage({ kind: "status", text: "当前页没有可复制样本。" });
      return;
    }
    setMarkdownOpen(true);
    const copied = await copyText(markdown);
    setStatusMessage({
      kind: "status",
      text: copied ? "已复制当前页 markdown。" : "当前浏览器不支持自动复制，请展开后手动复制。",
    });
  }

  function refreshCurrentCasebookPage() {
    setStatusMessage(null);
    setPendingDeleteCardId(null);
    setMarkdownOpen(false);
    void load();
  }

  if (casebookBlockingError(error, hasLoaded, currentQueryKey, loadedQueryKey, filterValidationError)) {
    return (
      <div className="stack">
        <div className="view-toolbar">
          <button className="plain-button" onClick={() => onNavigate(dashboardRoutes.runs)} type="button">
            <ListChecks size={16} /> 批次列表
          </button>
          <div className="toolbar-actions">
            <button className="plain-button" onClick={refreshCurrentCasebookPage} disabled={loading} type="button">
              <RefreshCw size={16} /> 重新加载
            </button>
          </div>
        </div>
        <StateBlock title="样本库加载失败" detail={error ?? undefined} />
      </div>
    );
  }

  return (
    <div className="stack casebook-page">
      <section className="panel casebook-control">
        <div className="casebook-title-row">
          <div>
            <h2>样本库（{formatCount(visibleTotal)}）</h2>
            <p>稳定正负样本，用于复盘提示词、评估器和卡片生成质量。</p>
          </div>
          <div className="casebook-export-actions">
            <button className="plain-button" onClick={refreshCurrentCasebookPage} disabled={loading} type="button">
              <RefreshCw size={15} /> 刷新样本
            </button>
            <button
              aria-controls="casebook-markdown-export"
              aria-expanded={markdownOpen}
              className="plain-button"
              disabled={!exportEnabled}
              onClick={() => setMarkdownOpen((v) => !v)}
              title={exportEnabled ? "展开当前页 markdown" : casebookCopyUnavailableMessage(visibleLoading, error, filterValidationError)}
              type="button"
            >
              <Download size={15} /> 导出当前页
            </button>
            <button
              className="plain-button"
              disabled={!exportEnabled}
              onClick={() => void copyMarkdown()}
              title={exportEnabled ? "复制当前页 markdown" : casebookCopyUnavailableMessage(visibleLoading, error, filterValidationError)}
              type="button"
            >
              <ClipboardCopy size={15} /> 复制导出
            </button>
          </div>
        </div>
        <div className="casebook-filter-grid">
          <select aria-label="样本标签筛选" value={label} onChange={(event) => setLabel(event.target.value)}>
            <option value="">全部标签</option>
            <option value="great">好样本</option>
            <option value="bad">坏样本</option>
            <option value="surprising">惊喜</option>
            <option value="generic">泛化</option>
            <option value="hallucinated">幻觉</option>
            <option value="duplicate">重复</option>
            <option value="mistimed">时机不对</option>
            <option value="weak_source">证据弱</option>
          </select>
          <input
            type="number"
            min="0"
            max="10"
            step="0.5"
            value={minScore}
            onChange={(event) => setMinScore(event.target.value)}
            placeholder="最低分"
            aria-label="最低保存分"
          />
          <input
            type="number"
            min="0"
            max="10"
            step="0.5"
            value={maxScore}
            onChange={(event) => setMaxScore(event.target.value)}
            placeholder="最高分"
            aria-label="最高保存分"
          />
          <input
            aria-label="领域筛选"
            maxLength={REWARD_TEXT_FILTER_MAX_LENGTH}
            value={basket}
            onChange={(event) => setBasket(event.target.value)}
            placeholder="领域"
          />
          <input
            aria-label="意图筛选"
            maxLength={REWARD_TEXT_FILTER_MAX_LENGTH}
            value={intent}
            onChange={(event) => setIntent(event.target.value)}
            placeholder="意图"
          />
          <input
            type="number"
            min="0"
            max="10"
            step="0.5"
            value={minEvaluatorGap}
            onChange={(event) => setMinEvaluatorGap(event.target.value)}
            placeholder="最小分差"
            aria-label="最小评估器分差"
          />
          <input
            aria-label="更新时间晚于"
            type="date"
            value={since}
            max={until || undefined}
            onChange={(event) => setSince(event.target.value)}
            title="更新时间晚于"
          />
          <input
            aria-label="更新时间早于"
            type="date"
            value={until}
            min={since || undefined}
            onChange={(event) => setUntil(event.target.value)}
            title="更新时间早于"
          />
        </div>
        {filterValidationError && <div className="inline-error" role="alert">{filterValidationError}</div>}
        {statusMessage && (
          <div
            className={statusMessage.kind === "error" ? "inline-error" : "inline-status"}
            role={statusMessage.kind === "error" ? "alert" : "status"}
          >
            {statusMessage.text}
          </div>
        )}
        {refreshErrorText && <div className="inline-error" role="alert">{refreshErrorText}</div>}
        {markdownOpen && (
          <textarea
            aria-label="当前页样本库 markdown 导出"
            id="casebook-markdown-export"
            className="markdown-export"
            readOnly
            value={markdown}
            rows={12}
          />
        )}
      </section>
      <section className="casebook-summary-grid">
        <div>
          <span>当前页样本</span>
          <strong>{visibleItems.length}</strong>
          <p>筛选结果共 {formatCount(visibleTotal)} 条。</p>
        </div>
        <div>
          <span>正向/负向</span>
          <strong>{pagePositiveCount}/{pageNegativeCount}</strong>
          <p>按当前页标签判断。</p>
        </div>
        <div>
          <span>保存分均值</span>
          <strong>{scoreLabel(pageAvgScore)}</strong>
          <p>来自 casebook score snapshot。</p>
        </div>
        <div>
          <span>平均绝对分差</span>
          <strong>{gapLabel(pageAvgGap)}</strong>
          <p>评估器分数和人工/用户分的平均绝对差。</p>
        </div>
      </section>

      <section className="panel casebook-table-panel">
        <div className="casebook-table-wrap">
          <table aria-label="样本库列表" className="casebook-table">
            <thead>
              <tr>
                <th scope="col">标签</th>
                <th scope="col">卡片</th>
                <th scope="col">评分</th>
                <th scope="col">领域/意图</th>
                <th scope="col">证据与备注</th>
                <th scope="col">操作</th>
              </tr>
            </thead>
            <tbody>
              {visibleLoading || changedQueryError || visibleItems.length === 0 ? (
                <tr>
                  <td colSpan={6} className="casebook-empty-cell">{casebookTableEmptyMessage(visibleLoading, changedQueryError, filterValidationError)}</td>
                </tr>
              ) : (
                visibleItems.map((item) => {
                  const card = item.snapshot.card;
                  const evaluation = item.snapshot.evaluation;
                  const gap = caseGap(item);
                  const labelTone = casebookLabelTone(item.label);
                  const cardRouteId = firstDashboardRouteId(item.cardId, card?.id);
                  const runRouteId = firstDashboardRouteId(item.snapshot.run?.id, item.runId);
                  const traceRouteId = firstDashboardRouteId(item.snapshot.run?.runId, item.runId);
                  const canOpenCard = hasDashboardRouteId(cardRouteId);
                  const canOpenRun = hasDashboardRouteId(runRouteId);
                  const canOpenTrace = hasDashboardRouteId(traceRouteId);
                  const mutationCardId = casebookMutationCardId(item);
                  const canMutateCasebook = hasDashboardRouteId(mutationCardId);
                  const pendingDelete = pendingDeleteCardId === mutationCardId;
                  const deleting = deletingCardId === mutationCardId;
                  const deleteLabel = deleting ? "移除中" : pendingDelete ? "确认移除" : "移除";
                  return (
                    <tr key={`${item.id}:${mutationCardId || item.cardId || cardRouteId}`}>
                      <td>
                        <div className="casebook-label-cell">
                          <span className={`casebook-label ${labelTone}`}>{casebookLabelDisplay(item.label)}</span>
                          <small>{compactDate(item.updatedAt)}</small>
                        </div>
                      </td>
                      <td>
                        <button
                          className="casebook-title-button"
                          disabled={!canOpenCard}
                          onClick={() => onNavigate(dashboardRoutes.card(cardRouteId))}
                          title={canOpenCard ? "打开卡片详情" : dashboardRouteDisabledReason("card")}
                          type="button"
                        >
                          {clipDisplayText(cardTitle(card), "未命名卡片", 160)}
                        </button>
                        {card?.summary ? <p className="casebook-summary">{clipDisplayText(card.summary, "没有保存摘要。", 220)}</p> : null}
                      </td>
                      <td>
                        <div className="casebook-score-strip">
                          <span>保存 {scoreLabel(item.scoreSnapshot)}</span>
                          <span>评估 {scoreLabel(evaluation?.overall)}</span>
                          <span>分差 {gapLabel(gap)}</span>
                        </div>
                      </td>
                      <td>
                        <div className="casebook-meta-stack">
                          <strong>{clipDisplayText(card?.goalBasket ?? card?.goal_basket, "未知领域", 120)}</strong>
                          <span>{clipDisplayText(card?.intentKey ?? card?.intent_key, "无意图", 120)}</span>
                        </div>
                      </td>
                      <td>
                        <div className="casebook-evidence">
                          <span>{firstSource(item)}</span>
                          <em>{clipDisplayText(item.reviewerNote, "没有评审备注", 220)}</em>
                        </div>
                      </td>
                      <td>
                        <div className="casebook-row-actions">
                          <button
                            className="plain-button"
                            disabled={!canOpenCard}
                            onClick={() => onNavigate(dashboardRoutes.card(cardRouteId))}
                            title={canOpenCard ? "打开卡片详情" : dashboardRouteDisabledReason("card")}
                            type="button"
                          >
                            <ExternalLink size={14} /> 卡片
                          </button>
                          <button
                            className="plain-button"
                            disabled={!canOpenRun}
                            onClick={() => onNavigate(dashboardRoutes.run(runRouteId))}
                            title={canOpenRun ? "打开批次评审" : dashboardRouteDisabledReason("run")}
                            type="button"
                          >
                            <ListChecks size={14} /> 批次
                          </button>
                          <button
                            className="plain-button"
                            disabled={!canOpenTrace}
                            onClick={() => onNavigate(dashboardRoutes.trace(traceRouteId))}
                            title={canOpenTrace ? "打开生成链路" : dashboardRouteDisabledReason("trace")}
                            type="button"
                          >
                            <GitBranch size={14} /> 链路
                          </button>
                          <button
                            aria-label={`${deleteLabel} ${clipDisplayText(cardTitle(card), "未命名卡片", 160)}`}
                            className={`plain-button danger-action ${pendingDelete ? "confirming" : ""}`}
                            disabled={deleting || !canMutateCasebook}
                            onClick={() => void removeCase(item)}
                            title={!canMutateCasebook ? "缺少卡片 ID，不能移除" : pendingDelete ? "再次点击确认移除" : "从样本库移除"}
                            type="button"
                          >
                            <Trash2 size={14} /> {deleteLabel}
                          </button>
                        </div>
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
        <div className="casebook-pagination">
          <select
            aria-label="样本库每页条数"
            value={pageSize}
            onChange={(event) => setPageSize(normalizePageSize(Number(event.target.value), pageSizeOptions, 20))}
          >
            {pageSizeOptions.map((size) => (
              <option key={size} value={size}>{size} 条/页</option>
            ))}
          </select>
          <button disabled={page <= 1 || visibleLoading} onClick={() => setPage((value) => Math.max(1, value - 1))} type="button">
            <ChevronLeft size={16} />
            上一页
          </button>
          <span>{page} / {totalPages}</span>
          <button disabled={page >= totalPages || visibleLoading} onClick={() => setPage((value) => Math.min(totalPages, value + 1))} type="button">
            下一页
            <ChevronRight size={16} />
          </button>
        </div>
      </section>
    </div>
  );
}

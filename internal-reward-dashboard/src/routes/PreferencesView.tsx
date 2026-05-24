import { useCallback, useState } from "react";
import { MessageCircle, RefreshCw, UserRound } from "lucide-react";
import {
  addTargetPreference,
  listTargetPreferences,
  mintImpersonationToken,
} from "@/api/reward";
import type {
  PreferencePolarity,
  PreferenceRecord,
  PreferenceScope,
} from "@/api/reward";
import { StateBlock } from "@/components/StateBlock";

interface PreferencesViewProps {
  onNavigate: (path: string) => void;
}

const SCOPES: PreferenceScope[] = ["topic", "source", "timing", "format", "global"];
const POLARITIES: PreferencePolarity[] = ["positive", "negative"];

function sourceLabel(source: string): string {
  if (source === "internal_operator") return "内部代填";
  if (source === "user") return "用户本人";
  return source;
}

/**
 * Internal-operator preference console. The reviewer picks a target user
 * (by Supabase UUID), mints an impersonation token, then reads the target's
 * active preferences and can補一条 on the user's behalf. Server forces
 * source='internal_operator' on operator-driven writes, so user-原话 and
 * 代填 stay visually distinguishable in the list.
 */
export function PreferencesView({ onNavigate }: PreferencesViewProps) {
  void onNavigate;
  const [targetId, setTargetId] = useState("");
  const [token, setToken] = useState<string | null>(null);
  const [prefs, setPrefs] = useState<PreferenceRecord[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [statement, setStatement] = useState("");
  const [scope, setScope] = useState<PreferenceScope>("topic");
  const [polarity, setPolarity] = useState<PreferencePolarity>("positive");
  const [submitting, setSubmitting] = useState(false);

  const loadForTarget = useCallback(async () => {
    const trimmed = targetId.trim();
    if (!trimmed) return;
    setLoading(true);
    setError(null);
    try {
      const minted = await mintImpersonationToken(trimmed);
      setToken(minted.token);
      const items = await listTargetPreferences(minted.token);
      setPrefs(items);
    } catch (e) {
      setToken(null);
      setPrefs([]);
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [targetId]);

  const submitPreference = useCallback(async () => {
    if (!token) return;
    const trimmed = statement.trim();
    if (!trimmed) return;
    setSubmitting(true);
    setError(null);
    try {
      await addTargetPreference(token, { statement: trimmed, scope, polarity });
      setStatement("");
      const items = await listTargetPreferences(token);
      setPrefs(items);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSubmitting(false);
    }
  }, [token, statement, scope, polarity]);

  return (
    <div className="view-stack">
      <header className="view-header">
        <h1>用户偏好</h1>
        <p>选定目标用户后，以内部身份读取并代填高权重偏好（来源服务端强制标记）。</p>
      </header>

      <div className="filter-row">
        <label className="field">
          <span className="field-label">目标用户 Supabase UUID</span>
          <input
            type="text"
            aria-label="目标用户 Supabase UUID"
            value={targetId}
            onChange={(e) => setTargetId(e.target.value)}
            placeholder="00000000-0000-0000-0000-000000000000"
          />
        </label>
        <button
          className="primary-button"
          type="button"
          onClick={() => void loadForTarget()}
          disabled={loading || !targetId.trim()}
        >
          <RefreshCw size={14} />
          {loading ? "加载中" : "加载偏好"}
        </button>
      </div>

      {error && <div className="inline-error" role="alert">{error}</div>}

      {token && (
        <section className="panel">
          <h2 className="panel-title"><MessageCircle size={15} /> 代填一条偏好</h2>
          <textarea
            aria-label="偏好描述"
            value={statement}
            onChange={(e) => setStatement(e.target.value)}
            placeholder="用一句话描述用户的持续性偏好（例如：想看更多 A 股新闻）"
            rows={2}
          />
          <div className="filter-row">
            <label className="field">
              <span className="field-label">范围</span>
              <select aria-label="偏好范围" value={scope} onChange={(e) => setScope(e.target.value as PreferenceScope)}>
                {SCOPES.map((s) => (
                  <option key={s} value={s}>{s}</option>
                ))}
              </select>
            </label>
            <label className="field">
              <span className="field-label">极性</span>
              <select
                aria-label="偏好极性"
                value={polarity}
                onChange={(e) => setPolarity(e.target.value as PreferencePolarity)}
              >
                {POLARITIES.map((p) => (
                  <option key={p} value={p}>{p}</option>
                ))}
              </select>
            </label>
            <button
              className="primary-button"
              type="button"
              onClick={() => void submitPreference()}
              disabled={submitting || !statement.trim()}
            >
              {submitting ? "提交中" : "以内部身份提交"}
            </button>
          </div>
        </section>
      )}

      {token && prefs.length === 0 && !loading && (
        <StateBlock title="该用户暂无 active 偏好" />
      )}

      {prefs.length > 0 && (
        <ul className="list">
          {prefs.map((p) => (
            <li key={p.id} className="list-item">
              <div className="list-item-main">
                <span className="badge">
                  <UserRound size={12} /> {sourceLabel(p.source)}
                </span>
                <span className="badge">{p.scope}</span>
                <span className="badge">{p.polarity}</span>
                <span className="badge">w={p.weight}</span>
              </div>
              <p>{p.statement}</p>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

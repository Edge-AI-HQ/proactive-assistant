/**
 * HITL 审批卡(RC-5) — 渲染一个暂停在副作用工具上的 agent run。
 *
 * 当 conversation `/stream` 推来 `chat:requires_action` frame(agent 调了需审批的
 * 副作用工具,如 GMAIL_SEND_DRAFT / preference_add),`useAgentRun` 把它存进
 * `awaitingDecision`;本组件渲染工具名 + 入参预览 + Approve/Reject,用户的决定经
 * `/conversation/decision` 回流并以 `Command(resume=)` 续跑同一个 run。
 *
 * Corner-case 态(plan §十六):
 *   disabled — 决定提交中 / 该 turn 仍在 streaming → 按钮置灰(防重复提交;CC8 双击
 *     另有后端 idempotency 兜底)。
 *   readOnly — 历史里被 compress 的旧审批(run 早已 resolve,CC7)→ 只读灰显、无按钮。
 */
import { useState } from "react";
import { Check, X } from "lucide-react";
import type { HitlRequiresAction } from "@pin-ai/core";
import { Button } from "../../primitives/Button";
import { Text } from "../../primitives/Text";

// Phase 3：HitlRequiresAction 类型已迁 @pin-ai/core（envelope 域形状，
// machines/conversation.ts）；此处 re-export 保持旧 import 路径兼容。
export type { HitlRequiresAction } from "@pin-ai/core";

export interface HitlApprovalCardProps {
  action: HitlRequiresAction;
  /** Decision submitting / turn still streaming → grey out (no double-submit). */
  disabled?: boolean;
  /** Stale card from compressed history → read-only, no buttons. */
  readOnly?: boolean;
  onDecide: (decision: "approve" | "reject", message?: string) => void;
}

export function HitlApprovalCard({
  action,
  disabled = false,
  readOnly = false,
  onDecide,
}: HitlApprovalCardProps) {
  const [rejecting, setRejecting] = useState(false);
  const [reason, setReason] = useState("");
  const allowed = action.allowedDecisions;
  const canReject = allowed.length === 0 || allowed.includes("reject");
  const canApprove = allowed.length === 0 || allowed.includes("approve");

  return (
    <div className="rounded-xl border border-amber-400/30 bg-amber-50/40 overflow-hidden">
      <div className="flex items-center gap-2.5 px-3 py-2.5">
        <div className="w-7 h-7 rounded-lg bg-amber-100 border border-amber-300/50 flex items-center justify-center shrink-0">
          {/* emoji 装饰：保留 span（text-bodySm 设 emoji 大小，非 typeScale 文本;
              aria-hidden 不可丢——Text 契约不透传 aria，故用原生 span）。 */}
          <span className="text-bodySm" aria-hidden>
            ⚠️
          </span>
        </div>
        <div className="flex-1 min-w-0">
          <Text variant="micro" weight="semibold" className="block uppercase tracking-wider text-amber-700/70 leading-none mb-1">
            Needs your approval
          </Text>
          <Text variant="bodySm" weight="semibold" className="block text-foreground/85 truncate leading-tight">
            {action.toolName}
          </Text>
        </div>
      </div>

      {action.argsPreview ? (
        <div className="px-3 pb-2">
          <pre className="text-caption text-foreground/60 bg-foreground/[0.03] rounded-lg px-2.5 py-2 overflow-x-auto whitespace-pre-wrap break-words">
            {action.argsPreview}
          </pre>
        </div>
      ) : null}

      {readOnly ? (
        <div className="px-3 py-2 border-t border-foreground/8">
          <Text variant="caption" className="block text-foreground/40 italic">Resolved earlier</Text>
        </div>
      ) : rejecting ? (
        <div className="px-3 py-2.5 border-t border-foreground/8 space-y-2">
          <textarea
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="Optional: tell the agent why (it continues without running the tool)"
            rows={2}
            disabled={disabled}
            className="w-full text-label rounded-lg border border-foreground/12 px-2.5 py-1.5 resize-none focus:outline-none focus:ring-1 focus:ring-foreground/20 disabled:opacity-50"
          />
          <div className="flex gap-2 justify-end">
            <Button
              variant="ghost"
              size="sm"
              disabled={disabled}
              onPress={() => {
                setRejecting(false);
                setReason("");
              }}
            >
              Back
            </Button>
            <Button
              variant="danger"
              size="sm"
              disabled={disabled}
              onPress={() => onDecide("reject", reason.trim() || undefined)}
            >
              Reject
            </Button>
          </div>
        </div>
      ) : (
        <div className="flex gap-2 px-3 py-2.5 border-t border-foreground/8 justify-end">
          {canReject ? (
            <Button
              variant="ghost"
              size="sm"
              disabled={disabled}
              onPress={() => setRejecting(true)}
              leftIcon={<X size={14} strokeWidth={2} />}
            >
              Reject
            </Button>
          ) : null}
          {canApprove ? (
            <Button
              variant="primary"
              size="sm"
              disabled={disabled}
              onPress={() => onDecide("approve")}
              leftIcon={<Check size={14} strokeWidth={2} />}
            >
              Approve
            </Button>
          ) : null}
        </div>
      )}
    </div>
  );
}

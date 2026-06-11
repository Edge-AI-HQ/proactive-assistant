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
import { cn } from "@/lib/utils";

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
          <span className="text-[13px]" aria-hidden>
            ⚠️
          </span>
        </div>
        <div className="flex-1 min-w-0">
          <p className="text-[10px] font-semibold uppercase tracking-wider text-amber-700/70 leading-none mb-1">
            Needs your approval
          </p>
          <p className="text-[13px] font-semibold text-foreground/85 truncate leading-tight">
            {action.toolName}
          </p>
        </div>
      </div>

      {action.argsPreview ? (
        <div className="px-3 pb-2">
          <pre className="text-[11px] text-foreground/60 bg-foreground/[0.03] rounded-lg px-2.5 py-2 overflow-x-auto whitespace-pre-wrap break-words">
            {action.argsPreview}
          </pre>
        </div>
      ) : null}

      {readOnly ? (
        <div className="px-3 py-2 border-t border-foreground/8">
          <p className="text-[11px] text-foreground/40 italic">Resolved earlier</p>
        </div>
      ) : rejecting ? (
        <div className="px-3 py-2.5 border-t border-foreground/8 space-y-2">
          <textarea
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="Optional: tell the agent why (it continues without running the tool)"
            rows={2}
            disabled={disabled}
            className="w-full text-[12px] rounded-lg border border-foreground/12 px-2.5 py-1.5 resize-none focus:outline-none focus:ring-1 focus:ring-foreground/20 disabled:opacity-50"
          />
          <div className="flex gap-2 justify-end">
            <button
              type="button"
              disabled={disabled}
              onClick={() => {
                setRejecting(false);
                setReason("");
              }}
              className="text-[12px] px-3 py-1.5 rounded-lg text-foreground/60 hover:bg-foreground/5 disabled:opacity-50"
            >
              Back
            </button>
            <button
              type="button"
              disabled={disabled}
              onClick={() => onDecide("reject", reason.trim() || undefined)}
              className="text-[12px] font-semibold px-3 py-1.5 rounded-lg bg-red-500 text-white hover:bg-red-600 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              Reject
            </button>
          </div>
        </div>
      ) : (
        <div className="flex gap-2 px-3 py-2.5 border-t border-foreground/8 justify-end">
          {canReject ? (
            <button
              type="button"
              disabled={disabled}
              onClick={() => setRejecting(true)}
              className={cn(
                "flex items-center gap-1.5 text-[12px] font-semibold px-3 py-1.5 rounded-lg",
                "text-foreground/70 hover:bg-foreground/5 disabled:opacity-50 disabled:cursor-not-allowed",
              )}
            >
              <X size={14} strokeWidth={2} />
              Reject
            </button>
          ) : null}
          {canApprove ? (
            <button
              type="button"
              disabled={disabled}
              onClick={() => onDecide("approve")}
              className={cn(
                "flex items-center gap-1.5 text-[12px] font-semibold px-3 py-1.5 rounded-lg",
                "bg-foreground text-background hover:bg-foreground/90 disabled:opacity-50 disabled:cursor-not-allowed",
              )}
            >
              <Check size={14} strokeWidth={2} />
              Approve
            </button>
          ) : null}
        </div>
      )}
    </div>
  );
}

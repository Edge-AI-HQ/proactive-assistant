"""Internal AI dev pipeline.

Linear (需求总线 + AgentSession) → coding agent (Codex/Claude/Cursor, 可换) → GitHub PR
→ preview (crabbox/cloudflare tunnel) → 对话式反复改 + 收敛控制.

设计 SSOT: docs/plans/2026-06-13-ai-dev-pipeline.mdx
"""

__version__ = "0.1.0"

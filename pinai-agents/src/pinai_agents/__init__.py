"""pinai-agents: Python LangChain + DeepAgents service.

Hosts the proactive-ai agents (generator / main chat / card chat) replacing
the OpenClaw container's agent runtime. APIs talks to this service via HTTP +
SSE; LLM calls go through LiteLLM (the master Anthropic key never lands here).
"""

__version__ = "0.1.0"

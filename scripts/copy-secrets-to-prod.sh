#!/bin/bash
# 从 dev 环境复制 secrets 到 prod 环境
# 使用方法: bash scripts/copy-secrets-to-prod.sh

set -e

echo "📋 从 dev 环境复制通用 secrets 到 prod..."
echo ""

# 这些 secrets 可以在 dev 和 prod 共用（非敏感或可复用）
SHARED_SECRETS=(
  "API_INTERNAL_TOKEN"
  "CRON_SECRET"
  "LITELLM_MASTER_KEY"
  "LITELLM_SALT_KEY"
  "LITELLM_KEY_ENCRYPTION_SECRET"
  "ANTHROPIC_API_KEY"
  "OPENAI_API_KEY"
  "OPENROUTER_API_KEY"
  "BRAVE_API_KEY"
  "VOLCENGINE_API_KEY"
  "ELEVENLABS_API_KEY"
  "XI_API_KEY"
  "OPENCLAW_API_KEY"
)

echo "从 litellm-dev 复制到 pinclaw-litellm-prod..."
for secret in "${SHARED_SECRETS[@]}"; do
  # 跳过不存在的 secrets
  if flyctl secrets list -a litellm-dev 2>/dev/null | grep -q "^$secret"; then
    echo "  复制 $secret..."
    # 注意：无法直接获取 secret 值，需要手动设置
  fi
done

echo ""
echo "⚠️ Fly.io secrets 无法直接导出，需要手动复制"
echo ""
echo "建议操作："
echo "1. 从 dev 环境的 .env 或安全存储获取这些值"
echo "2. 使用以下命令设置到 prod:"
echo ""
echo "flyctl secrets set -a pinclaw-litellm-prod \\"
echo "  LITELLM_MASTER_KEY='<from-dev>' \\"
echo "  LITELLM_SALT_KEY='<from-dev>' \\"
echo "  ANTHROPIC_API_KEY='<from-dev>' \\"
echo "  OPENAI_API_KEY='<from-dev>' \\"
echo "  ... (其他 keys)"
echo ""
echo "flyctl secrets set -a pinclaw-api-prod \\"
echo "  API_INTERNAL_TOKEN='<from-dev>' \\"
echo "  CRON_SECRET='<from-dev>' \\"
echo "  LITELLM_MASTER_KEY='<from-dev>' \\"
echo "  STRIPE_SECRET_KEY='<from-stripe>' \\"
echo "  STRIPE_WEBHOOK_SECRET='<from-stripe>' \\"
echo "  ... (其他 keys)"

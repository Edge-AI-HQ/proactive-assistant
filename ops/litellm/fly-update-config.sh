#!/bin/bash
# Fly.io 快速更新配置脚本(跳过构建)
# 当 fly deploy 因 Depot builder 超时失败时使用

set -e

APP_NAME="litellm-dev"
LITELLM_DIR="$(cd "$(dirname "$0")" && pwd)"

echo "📋 获取当前运行的镜像..."
cd "$LITELLM_DIR"
CURRENT_IMAGE=$(fly machines list -a $APP_NAME --json | jq -r '.[0].image_ref.registry + "/" + .[0].image_ref.repository + ":" + .[0].image_ref.tag')

if [ -z "$CURRENT_IMAGE" ] || [ "$CURRENT_IMAGE" = "null/null:null" ]; then
    echo "❌ 无法获取当前镜像,请检查应用是否正常运行"
    exit 1
fi

echo "✅ 当前镜像: $CURRENT_IMAGE"
echo ""
echo "🚀 使用现有镜像重新部署,应用 fly.toml 配置..."

fly deploy -a $APP_NAME --image "$CURRENT_IMAGE" --strategy immediate

echo ""
echo "✅ 配置更新完成!"
echo ""
echo "🔍 验证配置:"
fly config show -a $APP_NAME | grep -A 5 "http_service"

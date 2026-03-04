#!/bin/bash
# Fly.io 快速更新配置脚本(跳过构建)
# 当 fly deploy 因 Depot builder 超时失败时使用

set -e

LITELLM_DIR="$(cd "$(dirname "$0")" && pwd)"
APP_NAME="${APP_NAME:-litellm-dev}"

if [ -z "${FLY_CONFIG:-}" ]; then
    if [[ "$APP_NAME" == *prod* ]]; then
        FLY_CONFIG="$LITELLM_DIR/fly.prod.toml"
    else
        FLY_CONFIG="$LITELLM_DIR/fly.dev.toml"
    fi
fi

if [ ! -f "$FLY_CONFIG" ]; then
    echo "❌ 配置文件不存在: $FLY_CONFIG"
    exit 1
fi

echo "📋 获取当前运行的镜像..."
cd "$LITELLM_DIR"
CURRENT_IMAGE=$(fly machines list -a "$APP_NAME" --json | jq -r '.[0].image_ref.registry + "/" + .[0].image_ref.repository + ":" + .[0].image_ref.tag')

if [ -z "$CURRENT_IMAGE" ] || [ "$CURRENT_IMAGE" = "null/null:null" ]; then
    echo "❌ 无法获取当前镜像,请检查应用是否正常运行"
    exit 1
fi

echo "✅ 当前镜像: $CURRENT_IMAGE"
echo ""
echo "🚀 使用现有镜像重新部署,应用 $(basename "$FLY_CONFIG") 配置..."

fly deploy -a "$APP_NAME" --config "$FLY_CONFIG" --image "$CURRENT_IMAGE" --strategy immediate

echo ""
echo "✅ 配置更新完成!"
echo ""
echo "🔍 验证配置:"
fly config show -a "$APP_NAME" | grep -A 5 "http_service"

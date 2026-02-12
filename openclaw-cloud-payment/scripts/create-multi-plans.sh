#!/bin/bash

echo "🛍️ 创建 Stripe 多套餐价格"
echo ""

# 加载环境变量
if [ -f .env ]; then
    export $(cat .env | grep -v '^#' | xargs)
else
    echo "❌ 未找到 .env 文件"
    exit 1
fi

if [ -z "$STRIPE_SECRET_KEY" ]; then
    echo "❌ STRIPE_SECRET_KEY 未配置"
    exit 1
fi

# 获取已有的产品 ID
echo "📦 使用现有产品 ID: prod_TxaSJaApMtLhjp"
PRODUCT_ID="prod_TxaSJaApMtLhjp"

echo ""
echo "💰 创建 Pro 套餐价格 ($20/月)..."
pro_response=$(curl -s -u "$STRIPE_SECRET_KEY:" \
    https://api.stripe.com/v1/prices \
    -d "product=$PRODUCT_ID" \
    -d "unit_amount=2000" \
    -d "currency=usd" \
    -d "nickname=Pro Plan" \
    -d "recurring[interval]=month")

pro_price_id=$(echo "$pro_response" | grep -o '"id":"price_[^"]*"' | head -1 | cut -d'"' -f4)

if [ -z "$pro_price_id" ]; then
    echo "❌ 创建 Pro 价格失败"
    echo "$pro_response"
    exit 1
fi

echo "✅ Pro 价格创建成功"
echo "   Price ID: $pro_price_id"
echo ""

echo "💰 创建 Max 套餐价格 ($50/月)..."
max_response=$(curl -s -u "$STRIPE_SECRET_KEY:" \
    https://api.stripe.com/v1/prices \
    -d "product=$PRODUCT_ID" \
    -d "unit_amount=5000" \
    -d "currency=usd" \
    -d "nickname=Max Plan" \
    -d "recurring[interval]=month")

max_price_id=$(echo "$max_response" | grep -o '"id":"price_[^"]*"' | head -1 | cut -d'"' -f4)

if [ -z "$max_price_id" ]; then
    echo "❌ 创建 Max 价格失败"
    echo "$max_response"
    exit 1
fi

echo "✅ Max 价格创建成功"
echo "   Price ID: $max_price_id"
echo ""

echo "📝 请将以下内容添加到 .env 文件："
echo ""
echo "STRIPE_PRICE_ID_BASIC=price_1SzfI80RaPkgaisIGUh4EW2D"
echo "STRIPE_PRICE_ID_PRO=$pro_price_id"
echo "STRIPE_PRICE_ID_MAX=$max_price_id"
echo ""

# 自动更新 .env 文件
if grep -q "STRIPE_PRICE_ID_PRO=" .env; then
    sed -i.bak "s/STRIPE_PRICE_ID_PRO=.*/STRIPE_PRICE_ID_PRO=$pro_price_id/" .env
else
    echo "STRIPE_PRICE_ID_PRO=$pro_price_id" >> .env
fi

if grep -q "STRIPE_PRICE_ID_MAX=" .env; then
    sed -i.bak "s/STRIPE_PRICE_ID_MAX=.*/STRIPE_PRICE_ID_MAX=$max_price_id/" .env
else
    echo "STRIPE_PRICE_ID_MAX=$max_price_id" >> .env
fi

if grep -q "STRIPE_PRICE_ID_BASIC=" .env; then
    sed -i.bak "s/STRIPE_PRICE_ID_BASIC=.*/STRIPE_PRICE_ID_BASIC=price_1SzfI80RaPkgaisIGUh4EW2D/" .env
else
    echo "STRIPE_PRICE_ID_BASIC=price_1SzfI80RaPkgaisIGUh4EW2D" >> .env
fi

echo "✅ 已自动更新 .env 文件"
echo ""
echo "🎉 完成！现在需要："
echo "1. 将这些环境变量添加到 Vercel"
echo "2. 重新部署：vercel --prod"

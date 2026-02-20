#!/bin/bash

echo "🛍️ 创建 Stripe 产品和价格"
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

echo "📦 创建产品..."
product_response=$(curl -s -u "$STRIPE_SECRET_KEY:" \
    https://api.stripe.com/v1/products \
    -d "name=OpenClaw Cloud - Basic" \
    -d "description=2GB RAM Docker Container for OpenClaw")

product_id=$(echo "$product_response" | grep -o '"id":"prod_[^"]*"' | head -1 | cut -d'"' -f4)

if [ -z "$product_id" ]; then
    echo "❌ 创建产品失败"
    echo "$product_response"
    exit 1
fi

echo "✅ 产品创建成功"
echo "   Product ID: $product_id"
echo ""

echo "💰 创建价格..."
price_response=$(curl -s -u "$STRIPE_SECRET_KEY:" \
    https://api.stripe.com/v1/prices \
    -d "product=$product_id" \
    -d "unit_amount=1000" \
    -d "currency=usd" \
    -d "recurring[interval]=month")

price_id=$(echo "$price_response" | grep -o '"id":"price_[^"]*"' | head -1 | cut -d'"' -f4)

if [ -z "$price_id" ]; then
    echo "❌ 创建价格失败"
    echo "$price_response"
    exit 1
fi

echo "✅ 价格创建成功"
echo "   Price ID: $price_id"
echo ""

echo "📝 请将以下内容添加到 .env 文件："
echo ""
echo "STRIPE_PRICE_ID=$price_id"
echo ""

# 自动更新 .env 文件
if grep -q "STRIPE_PRICE_ID=" .env; then
    # 替换现有的
    sed -i.bak "s/STRIPE_PRICE_ID=.*/STRIPE_PRICE_ID=$price_id/" .env
    echo "✅ 已自动更新 .env 文件"
else
    # 添加新的
    echo "STRIPE_PRICE_ID=$price_id" >> .env
    echo "✅ 已自动添加到 .env 文件"
fi

echo ""
echo "🎉 完成！现在可以测试支付流程了"

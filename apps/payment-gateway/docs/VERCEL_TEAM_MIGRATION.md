# Vercel 企业空间迁移指南

## 问题说明

项目从个人账户迁移到企业空间（Team）后，本地的 `.vercel` 目录仍然指向旧的个人账户，导致部署失败。

## 解决步骤

### 1. 删除旧的链接配置

```bash
cd /Users/heyuehui/Desktop/PINAI/PIN-AI-ASSISTANT/apps/payment-gateway

# 删除旧的 Vercel 链接
rm -rf .vercel
```

### 2. 重新链接到企业空间

```bash
# 重新登录（确保登录到正确的账户）
vercel login

# 重新链接项目
vercel link
```

**交互式提示：**

```
? Set up and deploy "~/apps/payment-gateway"? [Y/n] y
? Which scope do you want to deploy to? <选择你的企业空间>
? Link to existing project? [Y/n] y
? What's the name of your existing project? <输入项目名称>
✅ Linked to <team-name>/<project-name>
```

### 3. 验证链接

```bash
# 查看当前链接的项目信息
vercel ls

# 或查看 .vercel/project.json
cat .vercel/project.json
```

应该看到：
```json
{
  "orgId": "team_xxxxx",  // 企业空间 ID
  "projectId": "prj_xxxxx"
}
```

### 4. 部署到企业空间

```bash
# 部署到预览环境
vercel

# 部署到生产环境
vercel --prod
```

## 环境变量迁移

企业空间的环境变量是独立的，需要重新配置：

```bash
# 查看当前环境变量
vercel env ls

# 如果为空，需要重新添加所有环境变量
vercel env add TELEGRAM_BOT_TOKEN production
vercel env add STRIPE_SECRET_KEY production
vercel env add STRIPE_WEBHOOK_SECRET production
vercel env add STRIPE_PRICE_ID_BASIC production
vercel env add STRIPE_PRICE_ID_PRO production
vercel env add STRIPE_PRICE_ID_MAX production
vercel env add SUPABASE_DB_URL production
vercel env add TELEGRAM_WEBHOOK_DOMAIN production
```

**或者在 Vercel Dashboard 中配置：**
1. 进入项目 Settings → Environment Variables
2. 逐个添加环境变量

## 常见问题

### Q1: vercel link 时找不到项目

**原因**：项目名称可能在迁移时改变了

**解决**：
1. 登录 Vercel Dashboard
2. 查看企业空间下的项目列表
3. 确认正确的项目名称
4. 重新运行 `vercel link` 并输入正确的名称

### Q2: 部署时提示权限不足

**原因**：你的账户在企业空间中没有部署权限

**解决**：
1. 联系企业空间管理员
2. 确保你的角色有 "Deploy" 权限
3. 在 Team Settings → Members 中检查权限

### Q3: 环境变量丢失

**原因**：环境变量不会自动迁移

**解决**：
- 从旧项目导出环境变量（如果还有访问权限）
- 或者从本地 `.env` 文件重新添加
- 使用 `vercel env pull` 拉取现有的环境变量

### Q4: Webhook URL 需要更新吗？

**可能需要**：如果项目 URL 改变了

**检查**：
```bash
# 部署后检查新的 URL
vercel ls

# 如果 URL 改变，需要更新：
# 1. Telegram Webhook
# 2. Stripe Webhook
# 3. TELEGRAM_WEBHOOK_DOMAIN 环境变量
```

## Git 配置

`.vercel` 目录应该在 `.gitignore` 中：

```bash
# 检查 .gitignore
cat .gitignore | grep .vercel

# 如果没有，添加它
echo ".vercel" >> .gitignore
```

这样每个开发者都可以链接到自己的 Vercel 账户。

## 团队协作最佳实践

### 1. 统一使用企业空间

所有团队成员都应该：
- 加入同一个企业空间
- 链接到同一个项目
- 使用 `vercel --prod` 部署到生产环境

### 2. 环境隔离

```bash
# 开发环境：本地开发
vercel dev

# 预览环境：功能分支
vercel

# 生产环境：主分支
vercel --prod
```

### 3. 权限管理

在企业空间中设置合适的角色：
- **Owner**: 完全控制
- **Member**: 可以部署和查看
- **Viewer**: 只能查看

## 验证迁移成功

```bash
# 1. 检查链接
vercel ls

# 2. 测试部署
vercel --prod

# 3. 检查环境变量
vercel env ls

# 4. 访问部署的 URL
curl https://your-app.vercel.app/api/health
```

## 总结

✅ 删除旧的 `.vercel` 目录
✅ 运行 `vercel link` 重新链接到企业空间
✅ 重新配置环境变量
✅ 更新 Webhook URLs（如果需要）
✅ 测试部署

迁移完成后，所有部署都会在企业空间下进行。

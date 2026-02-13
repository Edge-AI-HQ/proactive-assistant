# Vercel Monorepo 配置指南

## 问题说明

你的项目结构：
```
PIN-AI-ASSISTANT/
├── openclaw-cloud-payment/    # 这个目录需要部署到 Vercel
├── other-service-1/
└── other-service-2/
```

默认情况下，Vercel 会在 **任何文件** 变动时都触发部署，即使变动的文件不在 `openclaw-cloud-payment` 目录中。

## 解决方案

### 方法 1：使用 vercel.json（已配置）

已经在 `vercel.json` 中添加了 `ignoreCommand`：

```json
{
  "ignoreCommand": "bash -c 'git diff HEAD^ HEAD --quiet -- . && exit 1 || exit 0'"
}
```

**工作原理：**
- `git diff HEAD^ HEAD --quiet -- .` 检查当前目录（`.`）是否有变动
- 如果没有变动（`--quiet` 返回 0）→ `exit 1` → Vercel 跳过部署
- 如果有变动（`--quiet` 返回非 0）→ `exit 0` → Vercel 继续部署

### 方法 2：Vercel Dashboard 配置（推荐作为补充）

1. 登录 [Vercel Dashboard](https://vercel.com/dashboard)
2. 选择你的项目
3. 进入 **Settings → Git**
4. 找到 **Root Directory** 设置
5. 设置为：`openclaw-cloud-payment`
6. 找到 **Ignored Build Step** 设置
7. 选择 **Custom**，输入：
   ```bash
   git diff HEAD^ HEAD --quiet -- openclaw-cloud-payment/
   ```

### 方法 3：使用 Turborepo（适合大型 monorepo）

如果你的 monorepo 有多个需要部署的服务，考虑使用 Turborepo：

```bash
# 在根目录安装
npm install turbo --save-dev

# 创建 turbo.json
{
  "pipeline": {
    "build": {
      "dependsOn": ["^build"],
      "outputs": [".vercel/**"]
    }
  }
}
```

## 测试配置

### 测试 1：修改其他目录的文件

```bash
# 在根目录
cd /Users/heyuehui/Desktop/PINAI/PIN-AI-ASSISTANT
echo "test" >> other-service/README.md
git add .
git commit -m "test: change in other service"
git push
```

**预期结果**：Vercel 不应该触发 openclaw-cloud-payment 的部署

### 测试 2：修改 openclaw-cloud-payment 的文件

```bash
cd openclaw-cloud-payment
echo "test" >> README.md
git add .
git commit -m "test: change in payment service"
git push
```

**预期结果**：Vercel 应该触发部署

## 验证部署

```bash
# 查看 Vercel 部署日志
vercel logs

# 或在 Dashboard 查看
# https://vercel.com/dashboard → 你的项目 → Deployments
```

## 常见问题

### Q1: 为什么还是触发了部署？

**可能原因：**
1. `vercel.json` 没有提交到 git
2. Vercel 缓存了旧配置（等待几分钟）
3. 修改了根目录的配置文件（如 `package.json`）

**解决方法：**
```bash
# 确保 vercel.json 已提交
git add vercel.json
git commit -m "chore: add vercel monorepo config"
git push

# 在 Vercel Dashboard 手动触发一次部署
# Settings → Git → Redeploy
```

### Q2: ignoreCommand 返回值含义

- `exit 0` = 继续部署
- `exit 1` = 跳过部署
- `exit 2+` = 部署失败（错误）

### Q3: 如何调试 ignoreCommand？

在本地测试：

```bash
cd openclaw-cloud-payment

# 模拟 Vercel 的检查
git diff HEAD^ HEAD --quiet -- .
echo $?  # 0 = 没有变动，非0 = 有变动

# 完整命令
bash -c 'git diff HEAD^ HEAD --quiet -- . && exit 1 || exit 0'
echo $?  # 1 = 跳过部署，0 = 继续部署
```

### Q4: 如果依赖根目录的文件怎么办？

如果 `openclaw-cloud-payment` 依赖根目录的某些文件（如共享的 `package.json`），修改 ignoreCommand：

```json
{
  "ignoreCommand": "bash -c 'git diff HEAD^ HEAD --quiet -- . ../package.json ../shared/ && exit 1 || exit 0'"
}
```

## 最佳实践

### 1. 明确的目录结构

```
PIN-AI-ASSISTANT/
├── services/
│   ├── openclaw-cloud-payment/    # Vercel 项目 1
│   ├── telegram-bot/              # Vercel 项目 2
│   └── admin-dashboard/           # Vercel 项目 3
├── shared/                        # 共享代码
└── package.json                   # 根 package.json
```

### 2. 每个服务独立的 vercel.json

每个服务都应该有自己的 `vercel.json`，配置独立的 `ignoreCommand`。

### 3. 使用 Git 标签触发部署

```bash
# 只部署特定服务
git tag payment-v1.0.0
git push origin payment-v1.0.0
```

在 Vercel 中配置只在特定标签时部署。

## 相关文档

- [Vercel Monorepo](https://vercel.com/docs/concepts/monorepos)
- [Ignored Build Step](https://vercel.com/docs/concepts/projects/overview#ignored-build-step)
- [Turborepo](https://turbo.build/repo/docs)

## 总结

✅ 已配置 `vercel.json` 的 `ignoreCommand`
✅ 只有 `openclaw-cloud-payment` 目录变动时才会触发部署
✅ 其他目录的变动会被忽略

提交并推送 `vercel.json` 后，配置即生效。

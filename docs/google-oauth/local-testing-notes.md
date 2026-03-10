# Google OAuth Local Testing Notes

## 背景
在这条功能开发过程中，为了加快本地联调，分支里一度加入了若干仅服务本地测试的代码路径。这些逻辑已经帮助完成了 Telegram、miniapp、Google OAuth、Docker 容器与 GWS 的端到端验证，但它们不适合作为共享的 `dev` 主线代码长期保留。

本文件记录这些本地测试改动的范围、删除原因，以及后续如需本地联调应采用的方式。

## 已删除或计划删除的本地测试专用改动

### 1. 本地订阅绕过
曾加入过针对本地 Docker 测试的订阅绕过逻辑，用于：
- 直接创建 assistant
- 允许 Telegram Router 在未订阅状态下继续把消息转发到 assistant

删除原因：
- 会增加共享代码路径复杂度
- 容易让 `dev` 和真实产品行为出现偏差
- 与正式支付/订阅链路的验收目标冲突

### 2. 本地 Anthropic 自动注入
曾在 Docker 容器创建阶段自动写入 `auth-profiles.json`，用于避免本地 reset 后因缺少 provider key 而报错。

删除原因：
- 这是本地 DX 逻辑，不是产品主线逻辑
- dev/prod 应走正式配置注入路径，而不是容器创建时的特殊补丁

### 3. 本地 miniapp 浏览器直开/代理路径
曾引入过：
- 本地 miniapp dev server 代理
- 浏览器直开 miniapp 的便捷测试入口
- 相关的 query/dev bootstrap 逻辑

删除原因：
- 正式产品只应依赖 Telegram WebApp session
- 这些逻辑会让前端和后端都出现额外分支
- 不利于收敛到 `dev` 可上线版本

### 4. 根级本地辅助脚本与命令
曾引入：
- `scripts/local-dev.mjs`
- `scripts/local-dev.test.mjs`
- 根 `package.json` 中的 `local:*` 命令
- `.env.local.example`
- 个人本地测试说明写入 `AGENTS.md`

删除原因：
- 这些属于个人/临时本地工作流
- 不适合作为团队共享仓库接口
- 容易与其他开发者的本地流程相互冲突

### 5. 旧的本地 Google 测试页
曾加入过：
- `/google/manage`
- 旧 `/oauth/google/*` 测试页/渲染代码

删除原因：
- 当前产品入口已经统一为 miniapp
- 旧页面只会制造双入口和歧义

## 保留在产品代码中的能力
以下能力仍然是主线产品逻辑，需要保留：
- miniapp 内 Connect Google / Disconnect Google
- Google OAuth state / callback / token 落库
- callback 后把凭据同步到 Docker/Fly runtime
- bot `google_connected` 主动提示
- OpenClaw 镜像内预装 `@googleworkspace/cli` 与 GWS skills

## 统一配置文件下发模式（长期建议）
后续类似 Google OAuth client secret、provider 凭据、默认配置文件等需求，建议统一采用：

1. 平台侧持有原始配置来源
- 通过 secret、env 或受控文件来源存储
- 不把敏感配置烘焙进代码仓库

2. 运行时按 runtime 下发并落盘
- Docker：写入容器对应数据目录
- Fly：通过 machine config/env 更新，并在启动时落到 `/app/data/<provider>/...`

3. 产品代码只消费稳定文件路径
- 例如 `/app/data/google/client_secret.json`
- 例如 `/app/data/google/gws-credentials.json`

这样做的原因：
- 凭据轮换不依赖镜像重建
- Docker/Fly 可以共享同一产品语义
- 后续新增配置文件需求时，扩展成本最低

## 以后如果还要做本地联调
建议方式：
- 在个人 worktree 上临时 patch
- 不提交到共享分支
- 用本地 `.env.local`、临时脚本、临时代理完成验证
- 联调通过后，把临时 patch 清理掉，再整理正式主线改动

结论：
- 共享代码只保留 `dev/prod` 产品逻辑
- 本地测试便利性通过临时 patch 解决，不再内置到主线代码

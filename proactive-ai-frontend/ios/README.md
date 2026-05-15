# iOS 本地开发

两种使用场景：

| 你想做什么 | 走哪条路 |
|---|---|
| **改前端 / 改原生代码 / 用 Xcode debugger** | 本地 `make ios` + Xcode Run（需要 onboarding） |
| **只是装 build 试试新功能** | 让 admin 把你加进 TestFlight → iPhone TestFlight app 装 |

如果你不需要 debugger，**优先走 TestFlight**，不用搞下面的 onboarding。

---

## 本地 Xcode debug onboarding（一次性，每台 Mac 一次）

### 1. 加进 Apple Developer Team

让 admin（Boliang）在 [App Store Connect → Users and Access](https://appstoreconnect.apple.com/access/users) 邀请你：
- **Roles**: 至少勾 `Developer`
- **Additional Resources**: 必须勾 `Access to Certificates, Identifiers & Profiles`

收邮件接受邀请。

### 2. Xcode 加 Apple ID

Xcode → Settings → Accounts → `+` → Apple ID → 登你刚被邀请的那个邮箱。

### 3. 生成你自己的 Apple Development cert

Apple Development cert 的**私钥只存在生成它那台 Mac 上**——你不能从别人那里"拷一份"，必须自己 Mac 本地生成。

在 Accounts 里选中 team `PIN AI` (`7T7C9L7H8F`) → **Manage Certificates...** → 左下角 `+` → **Apple Development**。Xcode 会向 Apple 申请 cert + 把私钥落到你 Mac 的 keychain。

> Apple 每人每 team 最多 2 个 Apple Development cert。如果点 `+` 报"limit reached"，去 [developer.apple.com/account/resources/certificates/list](https://developer.apple.com/account/resources/certificates/list) revoke 一个旧的再回来。

### 4. 注册你的 iPhone

插上 iPhone → 在 Xcode 选你的 device → 点 Run。第一次会弹"Register Device with team?"，点 Register，Xcode 会自动把 UDID 添加到 Apple Developer 后台。

---

## 日常使用

### Build + 开 Xcode 让你点 Run

```bash
make ios              # 默认连 fly dev（VITE_PIN_API_URL in pinai-agents/.env）
DEV=1 make ios        # 显式连 fly dev（同默认，覆盖 ./.env 里的 PAI_API_URL）
NGROK=<url> make ios  # 指定 ngrok URL
PROD=1 make ios       # 连 fly prod
```

优先级：`NGROK` > `PROD=1` > `DEV=1` > `PAI_API_URL` in `./.env`（tunnel，可选）> fly dev 默认。

`make ios` 走 `proactive-ai-frontend/scripts/sync-ios.sh`（vite build + cap sync + fix-deployment-target），跟 CI 的 archive 流程**前半段完全一致**——只是 CI 之后会 `xcodebuild archive`，本地是 `cap open ios` 让你手动 Run。

### 启用本地 pre-commit hook（强烈推荐）

防止 Xcode UI 误改 `DEVELOPMENT_TEAM` 又被你 commit 进去：

```bash
make githooks
```

这条只需跑一次。之后每次 commit 会先跑 `proactive-ai-frontend/scripts/check-ios-signing.sh` 检查 pbxproj 的 `DEVELOPMENT_TEAM` 是不是 `7T7C9L7H8F`（CI 那边也有同样的检查兜底）。

如果某次确实需要绕过：`git commit --no-verify`。

---

## 故障排查

### "No Account for Team 7T7C9L7H8F"

Xcode 没登录有权限的 Apple ID。回 Step 1-2 onboarding。

### "No profiles for 'ai.pin.proactive' were found"

Apple ID 登了，但 cert 还没生成。回 Step 3 generate Apple Development cert。

### "No signing certificate ... Apple Development"

跟上一条同因，回 Step 3。

### Build 成功但装不到 iPhone

第一次会弹"Register Device" → 确认。已注册过的 iPhone 在 [developer.apple.com/account/resources/devices/list](https://developer.apple.com/account/resources/devices/list) 能看到。

### 我有多个 Apple Developer team，想用其他 team 本地 debug

**不要直接改 pbxproj** —— commit 进去会让其他人 build 不动（这是 `check-ios-signing.sh` 兜的事）。

正确做法：
1. Xcode 里 Signing & Capabilities 改 team → **build 成功**
2. `git checkout -- proactive-ai-frontend/ios/App/App.xcodeproj/project.pbxproj` 把 team 改动 revert 掉
3. 重新 build 时 Xcode 会再次 rewrite pbxproj，但**不要 stage / commit 那条 diff**

或者直接接受不能 commit pbxproj 改动这个事实——你只要本地能 build 就行。

### 我是 release engineer，想本地跑完整 TestFlight 上传

```bash
cd proactive-ai-frontend
# 准备 ASC API key + distribution profile 放到 ~/Library/MobileDevice/Provisioning Profiles/
export ASC_KEY_ID=... ASC_ISSUER_ID=... ASC_API_KEY_PATH=...
bash scripts/build-ios.sh dev
```

走 CI 同一个脚本，产物上 TestFlight。日常请走 GitHub Actions 的 `Build iOS` workflow，不用本地跑。

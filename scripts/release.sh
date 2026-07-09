#!/usr/bin/env bash
# 发版:在 main 上打 v* tag,一条命令完成后端发布 + GitHub Release + 按需出 iOS prod。
#
# 用法:
#   scripts/release.sh v0.1.0     # 也接受 0.1.0,自动补 v 前缀
#
# 版本号约定(Semantic Versioning, https://semver.org):vMAJOR.MINOR.PATCH
#   MAJOR  破坏性改动(API / 数据格式不兼容,下游/前端要改才能用)
#   MINOR  向后兼容的新功能(加接口、加字段)
#   PATCH  向后兼容的 bugfix(不加新功能)
#   预发布  尾部加 -rc.1 / -beta.1(如 v1.0.0-rc.1),正式版去掉后缀
#   内测期 0.y.z:主版本 0 = 尚不稳定、随时可能破坏兼容。先发 v0.1.0,
#          加功能 bump MINOR(v0.2.0)、修 bug bump PATCH(v0.1.1);真正对外
#          稳定、开始承诺兼容时才发 v1.0.0。
#   一句话:看这次改动「会不会让现有用户/前端用不了」——会→MAJOR(内测期是
#          MINOR),只是加东西→MINOR,只是修 bug→PATCH。
#
# 这条命令做三件事:
#   1) 打 tag + push        → 触发 Deploy Prod(后端 agents+litellm+frontend,无人工审批)
#   2) gh release create    → 自动生成 changelog,出现在 Releases 页
#   3) 检测 app 代码改动     → 自上个 tag 起改过 apps/mobile/ 或
#      packages/ 就触发 RN iOS prod 构建(TestFlight),否则跳过。
#      (tag push 不支持 paths 过滤,所以这个"自动检测"放脚本里用 git diff 做;
#       dev 侧靠 build-ios.yml 的 push+paths 过滤,本来就只在动 app 时构建。)
#
# 前提(脚本会逐条校验):本地在 main、工作区干净、与 origin/main 完全一致
# —— 保证发出去的就是已 merge 进 main、过了 CI gate 的代码。
set -euo pipefail

REPO_SLUG="Edge-AI-HQ/PIN-AI-ASSISTANT"

VERSION="${1:-}"
if [[ -z "$VERSION" ]]; then
  echo "用法: $0 <version>   例: $0 v0.1.0" >&2
  exit 1
fi
[[ "$VERSION" == v* ]] || VERSION="v$VERSION"   # 自动补 v 前缀

# 版本号必须是 semver:vX.Y.Z,可带 -rc.1 之类预发布后缀
if ! [[ "$VERSION" =~ ^v[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$ ]]; then
  echo "❌ 版本号格式应为 vX.Y.Z(可带 -rc.1 预发布后缀):$VERSION" >&2
  exit 1
fi

# 必须在 main 分支
BRANCH="$(git rev-parse --abbrev-ref HEAD)"
if [[ "$BRANCH" != "main" ]]; then
  echo "❌ 发版必须在 main 分支,当前在 $BRANCH" >&2
  exit 1
fi

# 工作区必须干净(无未提交 / 未暂存改动)
if ! git diff --quiet || ! git diff --cached --quiet; then
  echo "❌ 工作区有未提交改动,先提交或 stash" >&2
  exit 1
fi

# 本地 main 必须与 origin/main 一致(发的是已 merge + 过 CI 的代码)
git fetch origin main --quiet
if [[ "$(git rev-parse @)" != "$(git rev-parse origin/main)" ]]; then
  echo "❌ 本地 main 与 origin/main 不一致,先 git pull --ff-only origin main" >&2
  exit 1
fi

# tag 不能重复(已发布的版本号不可覆盖)
if git rev-parse "$VERSION" >/dev/null 2>&1; then
  echo "❌ tag 已存在:$VERSION" >&2
  exit 1
fi

# 记录上一个 v* tag —— 必须在打新 tag 之前取,用于稍后 git diff 检测 app 改动。
PREV_TAG="$(git describe --tags --abbrev=0 --match 'v*' 2>/dev/null || true)"

SHA="$(git rev-parse --short HEAD)"
echo "准备发版 $VERSION → main@$SHA,这条命令会:"
echo "  1) push tag → 触发 Deploy Prod(后端,无人工审批,直接上 prod)"
echo "  2) 创建 GitHub Release(自动 changelog)"
echo "  3) 自 ${PREV_TAG:-起始} 起改过 app 代码的话,触发 iOS prod 构建(TestFlight)"
read -r -p "确认?(y/N) " ans
[[ "$ans" =~ ^[Yy]$ ]] || { echo "已取消"; exit 1; }

# --- 1) tag + push:核心步骤,触发 Deploy Prod。之后的步骤都是 best-effort, ---
# --- tag 已经 push、后端已在部署,gh 失败只警告、不回滚也不中断脚本。       ---
git tag -a "$VERSION" -m "Release $VERSION"
git push origin "$VERSION"
echo "✅ 已 push $VERSION,Deploy Prod 已触发。"

# --- 2) GitHub Release + 自动 changelog(从上个 release 到现在的 PR/commit)---
if gh release create "$VERSION" --generate-notes --title "$VERSION"; then
  echo "✅ GitHub Release $VERSION 已创建。"
else
  echo "⚠️  gh release create 失败(tag 已 push、后端部署不受影响)。" >&2
  echo "    手动补:gh release create $VERSION --generate-notes" >&2
fi

# --- 3) app 代码有改动才出 iOS prod ---
if [[ -n "$PREV_TAG" ]]; then
  app_changed="$(git diff --name-only "$PREV_TAG..HEAD" -- apps/mobile/ packages/)"
else
  app_changed="first-release"   # 没有上个 tag,首次发版默认出一次 iOS prod
fi

if [[ -n "$app_changed" ]]; then
  echo "检测到 app 代码改动 → 触发 iOS prod 构建(TestFlight)…"
  if gh workflow run build-rn-ios.yml -f environment=prod --ref "$VERSION"; then
    echo "✅ iOS prod 构建已触发。"
  else
    echo "⚠️  触发 iOS prod 失败,手动补:" >&2
    echo "    gh workflow run build-rn-ios.yml -f environment=prod --ref $VERSION" >&2
  fi
else
  echo "ℹ️  自 $PREV_TAG 起无 app 代码改动,跳过 iOS prod。"
  echo "    需要时手动:gh workflow run build-ios.yml -f environment=prod --ref $VERSION"
fi

echo ""
echo "看进度:"
echo "  · Deploy Prod: https://github.com/$REPO_SLUG/actions/workflows/deploy-prod.yml"
echo "  · Build iOS:   https://github.com/$REPO_SLUG/actions/workflows/build-ios.yml"
echo "  · Release:     https://github.com/$REPO_SLUG/releases/tag/$VERSION"

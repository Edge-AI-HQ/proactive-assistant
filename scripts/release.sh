#!/usr/bin/env bash
# 发版:在 main 上打 v* tag 并 push,自动触发 Deploy Prod。
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
# 前提(脚本会逐条校验):本地在 main、工作区干净、与 origin/main 完全一致
# —— 保证发出去的就是已 merge 进 main、过了 CI gate 的代码。
# push tag 后 GitHub 自动跑 Deploy Prod(prod 当前无人工审批,直接部署
# pinai-agents + litellm + frontend,并随部署跑 yoyo migration)。
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

SHA="$(git rev-parse --short HEAD)"
echo "准备发版 $VERSION → main@$SHA"
echo "push 后自动触发 Deploy Prod(prod 直接部署,无人工审批)。"
read -r -p "确认?(y/N) " ans
[[ "$ans" =~ ^[Yy]$ ]] || { echo "已取消"; exit 1; }

git tag -a "$VERSION" -m "Release $VERSION"
git push origin "$VERSION"

echo "✅ 已 push $VERSION,Deploy Prod 已触发。看部署进度:"
echo "   https://github.com/$REPO_SLUG/actions/workflows/deploy-prod.yml"

#!/usr/bin/env bash
# PrismSearch GitHub 仓库初始化脚本（与 setup-github.ps1 功能相同）
#
# 作用（均可重复执行，已存在则更新）：
#   1. 创建 / 更新 issue 与 PR 标签（labeler、release-drafter、dependabot、stale、ISSUE_TEMPLATE 用到的全部标签）
#   2. 开启 Discussions、合并后自动删除分支
#   3. 开启私密漏洞报告、Dependabot alerts 与 security updates、secret scanning 与 push protection
#   4. 设置 main 分支保护：必须通过 CI 的全部必需检查
#
# 前置：安装 GitHub CLI（https://cli.github.com），并以仓库管理员身份 `gh auth login`
# 用法：
#   bash scripts/dev/setup-github.sh                       # 默认仓库 xiaonerner0821/prismsearch
#   bash scripts/dev/setup-github.sh owner/repo            # 指定仓库
#   REPO=owner/repo bash scripts/dev/setup-github.sh
#
# 任何一步失败都只打印提示并继续，最后汇总失败的步骤。

set -u

REPO="${1:-${REPO:-xiaonerner0821/prismsearch}}"
FAILED=()

info() { printf '\033[36m==>\033[0m %s\n' "$*"; }
ok()   { printf '    \033[32m✔\033[0m %s\n' "$*"; }
warn() { printf '    \033[33m✘ %s\033[0m\n' "$*" >&2; }

# run <描述> <命令...>：失败时提示并记录，不中断脚本
run() {
  local desc="$1"; shift
  local out
  if out="$("$@" 2>&1)"; then
    ok "$desc"
  else
    warn "$desc 失败：$(printf '%s' "$out" | tail -n 3)"
    FAILED+=("$desc")
  fi
}

if ! command -v gh >/dev/null 2>&1; then
  echo "未找到 gh（GitHub CLI），请先安装：https://cli.github.com" >&2
  exit 1
fi
if ! gh auth status >/dev/null 2>&1; then
  echo "gh 尚未登录，请先执行：gh auth login" >&2
  exit 1
fi
if ! gh repo view "$REPO" >/dev/null 2>&1; then
  echo "无法访问仓库 $REPO（不存在或没有权限）" >&2
  exit 1
fi
info "目标仓库：$REPO"

# ---------------------------------------------------------------------------
# 1. 标签：名称|颜色|描述
# ---------------------------------------------------------------------------
LABELS=(
  # 变更类型（release-drafter 分类与版本号推断）
  "feature|a2eeef|新功能"
  "enhancement|a2eeef|功能改进或功能请求"
  "bug|d73a4a|缺陷报告"
  "fix|d73a4a|缺陷修复"
  "performance|fbca04|性能与稳定性改进"
  "breaking|b60205|破坏性变更（触发主版本号升级）"
  "security|ee0701|安全相关"
  "documentation|0075ca|文档"
  "ci|5319e7|CI / GitHub 工作流"
  "docker|0db7ed|Docker 镜像与编排"
  "tests|c2e0c6|测试"
  "dependencies|0366d6|依赖更新"
  "skip-changelog|eeeeee|不写入发布说明"
  # 模块（labeler 按路径自动打）
  "engine|1d76db|搜索引擎实现"
  "fetcher|1d76db|网页抓取 fetch_page"
  "server|1d76db|MCP 服务器与传输层"
  "config|1d76db|配置加载与配置文件"
  "cache|1d76db|缓存"
  "worker|7057ff|抓取 Worker（TS / Python）"
  # issue 流转
  "new-engine|bfdadc|请求接入新的搜索引擎"
  "live-test|f9d0c4|定时联网冒烟测试失败"
  "help wanted|008672|欢迎社区贡献"
  "good first issue|7057ff|适合新贡献者"
  "keep-open|0e8a16|不被 stale 机器人自动关闭"
  "pinned|0e8a16|长期保留，不被 stale 机器人处理"
  "stale|cccccc|长期无活动，即将自动关闭"
)

info "创建 / 更新标签（${#LABELS[@]} 个）"
for entry in "${LABELS[@]}"; do
  IFS='|' read -r name color desc <<<"$entry"
  run "标签 $name" gh label create "$name" --repo "$REPO" --color "$color" --description "$desc" --force
done

# ---------------------------------------------------------------------------
# 2. 仓库功能开关
# ---------------------------------------------------------------------------
info "仓库设置"
run "开启 Discussions" gh repo edit "$REPO" --enable-discussions
run "合并后自动删除分支" gh repo edit "$REPO" --delete-branch-on-merge

# ---------------------------------------------------------------------------
# 3. 安全功能
# ---------------------------------------------------------------------------
info "安全功能"
run "私密漏洞报告" gh api -X PUT "repos/$REPO/private-vulnerability-reporting" --silent
run "Dependabot alerts" gh api -X PUT "repos/$REPO/vulnerability-alerts" --silent
run "Dependabot security updates" gh api -X PUT "repos/$REPO/automated-security-fixes" --silent
run "Secret scanning 与 push protection" gh api -X PATCH "repos/$REPO" --silent --input - <<'JSON'
{
  "security_and_analysis": {
    "secret_scanning": { "status": "enabled" },
    "secret_scanning_push_protection": { "status": "enabled" }
  }
}
JSON

# ---------------------------------------------------------------------------
# 4. main 分支保护
#    检查名 = .github/workflows/ci.yml 中 job 的 name（矩阵展开后的完整名称），
#    改 ci.yml 的 job 名或矩阵时必须同步这里。新仓库需要先跑过一次 CI，
#    这些检查名才会出现在设置页面里（API 设置不受此限制）。
#    需要 PR 才能合入但不强制审批人数（单人维护也能合并），管理员不受限以便应急。
# ---------------------------------------------------------------------------
info "main 分支保护"
run "main 分支保护" gh api -X PUT "repos/$REPO/branches/main/protection" --silent \
  -H "Accept: application/vnd.github+json" --input - <<'JSON'
{
  "required_status_checks": {
    "strict": true,
    "contexts": [
      "测试 (ubuntu-latest / Node 22)",
      "测试 (ubuntu-latest / Node 24)",
      "测试 (windows-latest / Node 22)",
      "测试 (windows-latest / Node 24)",
      "测试 (macos-latest / Node 22)",
      "测试 (macos-latest / Node 24)",
      "TS Worker (Node 22)",
      "TS Worker (Node 24)",
      "Python Worker (3.10)",
      "Python Worker (3.12)",
      "secret-scan",
      "镜像构建 (主服务)",
      "镜像构建 (TS Worker)",
      "镜像构建 (Python Worker)"
    ]
  },
  "enforce_admins": false,
  "required_pull_request_reviews": {
    "dismiss_stale_reviews": true,
    "required_approving_review_count": 0
  },
  "restrictions": null,
  "required_linear_history": false,
  "allow_force_pushes": false,
  "allow_deletions": false,
  "required_conversation_resolution": true
}
JSON

echo
if [ "${#FAILED[@]}" -eq 0 ]; then
  info "全部完成"
else
  warn "以下 ${#FAILED[@]} 项失败，请按提示处理后重新运行本脚本（可重复执行）："
  for f in "${FAILED[@]}"; do warn "  - $f"; done
  echo "常见原因：账号不是仓库管理员；仓库尚未公开（部分安全功能仅公开仓库免费）；main 分支尚未推送。" >&2
  exit 1
fi

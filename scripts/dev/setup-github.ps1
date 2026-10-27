# PrismSearch GitHub 仓库初始化脚本（与 setup-github.sh 功能相同）
#
# 作用（均可重复执行，已存在则更新）：
#   1. 创建 / 更新 issue 与 PR 标签（labeler、release-drafter、dependabot、stale、ISSUE_TEMPLATE 用到的全部标签）
#   2. 开启 Discussions、合并后自动删除分支
#   3. 开启私密漏洞报告、Dependabot alerts 与 security updates、secret scanning 与 push protection
#   4. 设置 main 分支保护：必须通过 CI 的全部必需检查
#
# 前置：安装 GitHub CLI（https://cli.github.com），并以仓库管理员身份 `gh auth login`
# 用法（Windows PowerShell 5.1 / PowerShell 7 均可）：
#   powershell -ExecutionPolicy Bypass -File scripts/dev/setup-github.ps1
#   pwsh scripts/dev/setup-github.ps1 -Repo owner/repo
#
# 任何一步失败都只打印提示并继续，最后汇总失败的步骤。
# 注意：本文件需保存为 UTF-8 with BOM，否则 Windows PowerShell 5.1 会按 ANSI 读取导致中文乱码。

param(
  [string]$Repo = $(if ($env:REPO) { $env:REPO } else { 'xiaonerner0821/prismsearch' })
)

$ErrorActionPreference = 'Continue'
# gh 输出按 UTF-8 解码，避免中文提示乱码
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
$Utf8NoBom = New-Object System.Text.UTF8Encoding($false)
$script:Failed = New-Object System.Collections.Generic.List[string]

function Write-Info([string]$msg) { Write-Host "==> $msg" -ForegroundColor Cyan }
function Write-Ok([string]$msg) { Write-Host "    [OK] $msg" -ForegroundColor Green }
function Write-Warn2([string]$msg) { Write-Host "    [失败] $msg" -ForegroundColor Yellow }

# Invoke-Step <描述> <参数数组>：调用 gh，失败时提示并记录，不中断脚本
function Invoke-Step([string]$Desc, [string[]]$GhArgs) {
  $out = & gh @GhArgs 2>&1
  if ($LASTEXITCODE -eq 0) {
    Write-Ok $Desc
  } else {
    $tail = ($out | Select-Object -Last 3 | ForEach-Object { "$_" }) -join ' '
    Write-Warn2 "$Desc 失败：$tail"
    $script:Failed.Add($Desc)
  }
}

# 以 JSON 作为请求体调用 gh api（写临时文件，避免管道编码把中文变成问号）
function Invoke-ApiJson([string]$Desc, [string]$Method, [string]$Path, [string]$Json) {
  $tmp = [System.IO.Path]::GetTempFileName()
  try {
    [System.IO.File]::WriteAllText($tmp, $Json, $Utf8NoBom)
    Invoke-Step $Desc @('api', '-X', $Method, $Path, '--silent', '-H', 'Accept: application/vnd.github+json', '--input', $tmp)
  } finally {
    Remove-Item -LiteralPath $tmp -Force -ErrorAction SilentlyContinue
  }
}

if (-not (Get-Command gh -ErrorAction SilentlyContinue)) {
  Write-Host '未找到 gh（GitHub CLI），请先安装：https://cli.github.com' -ForegroundColor Red
  exit 1
}
& gh auth status *> $null
if ($LASTEXITCODE -ne 0) {
  Write-Host 'gh 尚未登录，请先执行：gh auth login' -ForegroundColor Red
  exit 1
}
& gh repo view $Repo *> $null
if ($LASTEXITCODE -ne 0) {
  Write-Host "无法访问仓库 $Repo（不存在或没有权限）" -ForegroundColor Red
  exit 1
}
Write-Info "目标仓库：$Repo"

# ---------------------------------------------------------------------------
# 1. 标签：名称|颜色|描述
# ---------------------------------------------------------------------------
$Labels = @(
  # 变更类型（release-drafter 分类与版本号推断）
  'feature|a2eeef|新功能'
  'enhancement|a2eeef|功能改进或功能请求'
  'bug|d73a4a|缺陷报告'
  'fix|d73a4a|缺陷修复'
  'performance|fbca04|性能与稳定性改进'
  'breaking|b60205|破坏性变更（触发主版本号升级）'
  'security|ee0701|安全相关'
  'documentation|0075ca|文档'
  'ci|5319e7|CI / GitHub 工作流'
  'docker|0db7ed|Docker 镜像与编排'
  'tests|c2e0c6|测试'
  'dependencies|0366d6|依赖更新'
  'skip-changelog|eeeeee|不写入发布说明'
  # 模块（labeler 按路径自动打）
  'engine|1d76db|搜索引擎实现'
  'fetcher|1d76db|网页抓取 fetch_page'
  'server|1d76db|MCP 服务器与传输层'
  'config|1d76db|配置加载与配置文件'
  'cache|1d76db|缓存'
  'worker|7057ff|抓取 Worker（TS / Python）'
  # issue 流转
  'new-engine|bfdadc|请求接入新的搜索引擎'
  'live-test|f9d0c4|定时联网冒烟测试失败'
  'help wanted|008672|欢迎社区贡献'
  'good first issue|7057ff|适合新贡献者'
  'keep-open|0e8a16|不被 stale 机器人自动关闭'
  'pinned|0e8a16|长期保留，不被 stale 机器人处理'
  'stale|cccccc|长期无活动，即将自动关闭'
)

Write-Info "创建 / 更新标签（$($Labels.Count) 个）"
foreach ($entry in $Labels) {
  $name, $color, $desc = $entry.Split('|', 3)
  Invoke-Step "标签 $name" @('label', 'create', $name, '--repo', $Repo, '--color', $color, '--description', $desc, '--force')
}

# ---------------------------------------------------------------------------
# 2. 仓库功能开关
# ---------------------------------------------------------------------------
Write-Info '仓库设置'
Invoke-Step '开启 Discussions' @('repo', 'edit', $Repo, '--enable-discussions')
Invoke-Step '合并后自动删除分支' @('repo', 'edit', $Repo, '--delete-branch-on-merge')

# ---------------------------------------------------------------------------
# 3. 安全功能
# ---------------------------------------------------------------------------
Write-Info '安全功能'
Invoke-Step '私密漏洞报告' @('api', '-X', 'PUT', "repos/$Repo/private-vulnerability-reporting", '--silent')
Invoke-Step 'Dependabot alerts' @('api', '-X', 'PUT', "repos/$Repo/vulnerability-alerts", '--silent')
Invoke-Step 'Dependabot security updates' @('api', '-X', 'PUT', "repos/$Repo/automated-security-fixes", '--silent')
Invoke-ApiJson 'Secret scanning 与 push protection' 'PATCH' "repos/$Repo" @'
{
  "security_and_analysis": {
    "secret_scanning": { "status": "enabled" },
    "secret_scanning_push_protection": { "status": "enabled" }
  }
}
'@

# ---------------------------------------------------------------------------
# 4. main 分支保护
#    检查名 = .github/workflows/ci.yml 中 job 的 name（矩阵展开后的完整名称），
#    改 ci.yml 的 job 名或矩阵时必须同步这里。新仓库需要先跑过一次 CI，
#    这些检查名才会出现在设置页面里（API 设置不受此限制）。
#    需要 PR 才能合入但不强制审批人数（单人维护也能合并），管理员不受限以便应急。
# ---------------------------------------------------------------------------
Write-Info 'main 分支保护'
Invoke-ApiJson 'main 分支保护' 'PUT' "repos/$Repo/branches/main/protection" @'
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
'@

Write-Host ''
if ($script:Failed.Count -eq 0) {
  Write-Info '全部完成'
} else {
  Write-Warn2 "以下 $($script:Failed.Count) 项失败，请按提示处理后重新运行本脚本（可重复执行）："
  foreach ($f in $script:Failed) { Write-Warn2 "  - $f" }
  Write-Host '常见原因：账号不是仓库管理员；仓库尚未公开（部分安全功能仅公开仓库免费）；main 分支尚未推送。' -ForegroundColor Yellow
  exit 1
}

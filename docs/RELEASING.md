# 发布指南

> 本文与仓库初始化脚本是公开治理材料，只包含公开仓库标识和操作说明，不应写入个人联系方式、设备路径、真实令牌、恢复码、生产日志或内部基础设施地址。本文不是“已配置”证明；GitHub、npm、GHCR 与 DNS/TLS 的平台设置必须由有权限的维护者实际执行并逐项验证。

### 当前发布流水线与人工门禁

以下是工作流应达到的依赖关系，平台设置仍需人工验证：`verify` 覆盖 Worker、审计、schema 与 main ancestry；`docker-verify` 执行真实镜像构建与健康检查；`sbom` 生成生产依赖 SBOM；`publish-npm` 依赖 verify、docker-verify、sbom，并执行 selfcheck、最终 tarball 安装 CLI 与 MCP smoke 后发布该 tarball；`publish-images` 依赖 npm 发布；`github-release` 依赖镜像发布并附带 SBOM。三个发布 job 均使用 `release` environment，但 required reviewers 与 tag 保护策略不会由工作流自动创建，必须在 GitHub Settings 中另行配置并完成验证。本机未执行 Docker/gh 平台验证，因此不能声称上述平台门禁已启用。


正式发布前，由仓库管理员在 Settings → Environments 创建发布环境（例如 `release`），设置 required reviewers、禁止自审、仅允许受保护的发布 tag；工作流必须引用该环境才会真正产生人工审批门禁。环境名必须与工作流保持一致。本指南不自动配置平台，也不证明门禁已启用。

在 Settings → Rules → Rulesets 创建适用于 `v*` tag 的规则，限制创建/更新/删除 tag 的权限，保护已发布版本；仅允许指定发布维护者或受审计的发布 App 绕过。不要通过删除并重建已发布 tag 复用 npm 版本。

首次 npm 发布可以使用短期、最小权限的 granular token，但应在人工环境审批后才注入发布 job；成功后配置 Trusted Publisher、删除 GitHub 中的临时 Secret，并在 npm 吊销令牌。尚不存在的包不一定能预先建立 Trusted Publisher，不应把它当作首发前的绝对要求。

平台验证清单（待有权限维护者执行）：

- [ ] Discussions、私密漏洞报告、Dependabot 与 secret scanning 已从设置页面或 API 确认启用
- [ ] main 规则要求真实存在的 CI 检查，且审查、绕过权限和管理员例外已记录
- [ ] 发布 job 引用的 environment 已启用人工审批并验证未审批时无法发布
- [ ] `v*` tag 的创建、更新、删除权限已限制，并用测试 tag 验证规则
- [ ] npm Trusted Publisher 或短期 bootstrap token 的使用范围、到期与吊销已记录
- [ ] npm provenance、GHCR 匿名拉取、Release 产物与 MCP Registry 元数据已核验


本文档面向维护者，说明 PrismSearch **首次开源与发布**的完整手动步骤，以及之后每次发版的常规流程。

自动化部分由 `.github/workflows/release.yml` 完成：推送 `vX.Y.Z` tag 后，先完成 verify、镜像健康与 SBOM 门禁，再依次发布 npm、镜像与 GitHub Release；Release 附带 SBOM。详细依赖见上文「当前发布流水线与人工门禁」。

| 项目 | 值 |
| --- | --- |
| GitHub 仓库 | `xiaonerner0821/prismsearch` |
| npm 包 | `prismsearch` |
| MCP Registry 名称 | `io.github.xiaonerner0821/prismsearch` |
| GHCR 镜像 | `ghcr.io/xiaonerner0821/prismsearch`、`ghcr.io/xiaonerner0821/prismsearch-ts-worker`、`ghcr.io/xiaonerner0821/prismsearch-py-worker` |

---

## 一、首次开源与发布（v0.3.1）

### 0. 发布前自检（本地）

```bash
npm ci
npm run lint && npm run typecheck && npm run build && npm test
node scripts/check-versions.mjs      # package.json / server.json / 两个 Worker 版本一致
npm pack --dry-run                   # 确认打包内容
```

确认 `CHANGELOG.md` 中已有 `## [0.3.1] - YYYY-MM-DD` 段落（`[未发布]` 里的内容已并入），
release.yml 会按这个标题提取发布说明，提取不到会直接失败。

### 1. 创建 GitHub 公开仓库并推送

1. 在 GitHub 上新建仓库 `xiaonerner0821/prismsearch`，可见性选 **Public**，
   **不要**勾选 README / LICENSE / .gitignore（避免与本地历史冲突）。
2. 关联远端并推送 main：

   ```bash
   git remote add origin https://github.com/xiaonerner0821/prismsearch.git
   git push -u origin main
   ```

3. **先不要推 tag**。等第 2～4 步（仓库设置、Codecov、NPM_TOKEN）完成、
   main 上的 CI 全绿之后再推 tag，否则发布流水线会因缺少 Secret 而失败。

### 2. 运行仓库初始化脚本

脚本基于 GitHub CLI，可重复执行（已存在的配置会被更新）。需要先 `gh auth login`，且账号是仓库管理员。

```bash
bash scripts/dev/setup-github.sh
# Windows：
powershell -ExecutionPolicy Bypass -File scripts/dev/setup-github.ps1
```

脚本会：

- 创建 / 更新全部标签（labeler、release-drafter、Dependabot、stale、Issue 模板要用到的标签，带颜色与描述）。
  标签不存在时，Dependabot 与 labeler 无法打标签；
- 开启 **Discussions**（`ISSUE_TEMPLATE/config.yml` 把使用问题引导到 Discussions，不开的话链接是 404）
  和「合并后自动删除分支」；
- 开启私密漏洞报告（`SECURITY.md` 与 Issue 模板里的安全链接依赖它）、Dependabot alerts 与 security updates、
  secret scanning 与 push protection；
- 设置 main 分支保护：合入需走 PR，且 CI 的全部检查（测试矩阵、两个 Worker、secret-scan、镜像构建）必须通过。

某一步失败时脚本会提示原因并继续，处理后重新运行即可。运行后建议到
**Settings → General → Features** 确认 Discussions 已勾选，并在 Discussions 里建好
「Q&A」「Ideas」等分类。

> 必需检查名取自 `ci.yml` 里各 job 的 `name`（矩阵展开后的完整名称）。以后修改 job 名或矩阵时，
> 需同步修改两个 setup-github 脚本并重新运行，否则 PR 会一直等待一个不存在的检查。

### 3. Codecov

1. 用 GitHub 账号登录 <https://codecov.io>，授权并启用 `xiaonerner0821/prismsearch`。
2. 公开仓库通常可以无 token 上传；若上传报 token 相关错误（或 Codecov 组织设置要求 token），
   在 Codecov 仓库设置页复制 Upload Token，添加为 GitHub 仓库 Secret `CODECOV_TOKEN`。
3. CI 中上传失败不会让流水线变红（`fail_ci_if_error: false`），以 Codecov 页面是否出现报告为准。

### 4. npm 首发：使用 granular NPM_TOKEN

包第一次发布前在 npm 上还不存在，无法预先配置 Trusted Publisher，因此首发需要一个临时 token。这个 token 是整个发布链路里权限最大的凭据，必须按「一次性引导凭据」处理：

1. 登录 <https://www.npmjs.com> → 头像 → **Access Tokens** → **Generate New Token** → **Granular Access Token**。
2. 配置：
   - **Packages and scopes**：Read and write，范围选 All packages（包尚未存在，无法只选 `prismsearch`）；
   - **Bypass two-factor authentication (2FA)**：只有账号开启了「发布需要 2FA」时才需要勾选（CI 无法输入 OTP）。勾选后该 token 等同于绕过 2FA 的发布权，因此必须同时满足下面的补偿措施；
   - **Expiration**：选可选的最短有效期（1 天优先，最长不超过 7 天），并在日历中记下吊销时间；
   - **Allowed IP ranges**：留空（GitHub 托管 runner 的出口 IP 不固定，无法收窄）。
3. 补偿措施（缺一项就不要推 tag）：
   - `release` environment 已配置 required reviewers，且 Secret 添加为 **environment secret**（Settings → Environments → `release` → Environment secrets），**不要**添加为仓库级 Secret，这样只有审批通过的发布 job 才能读到；
   - `v*` tag 规则集已生效，只有发布维护者能创建 tag；
   - 生成 token 到推送 tag 之间不做其他操作，首发成功后立即执行第 6 步吊销。
4. 在 **Settings → Environments → release → Environment secrets** 添加 `NPM_TOKEN`。

release.yml 的逻辑：`NPM_TOKEN` 存在时用它发布；不存在时不设置任何 token，走 Trusted Publishing（OIDC）。
两种方式都会附带 provenance。若不希望使用绕过 2FA 的 token，可以临时关闭账号的「发布需要 2FA」，首发并配置 Trusted Publisher 后再改为第 6 步的「Require two-factor authentication and disallow tokens」；两种做法任选其一，但都必须在首发后立即收紧。

### 5. 确认 release commit 与 tag 后触发发布

本地的 `v0.3.0` tag 指向开源加固之前的旧提交，从未推送、从未发布；维护者已决定**不移动、不复用**它，首个公开版本为 **0.3.1**（版本文件与 CHANGELOG 已更新）。不要推送 `v0.3.0`：

```bash
# 推送前确认远端不存在 v0.3.0，推 tag 时只推指定的 tag，不要用 --tags
git ls-remote --tags origin
# 可选：删除本地旧 tag，避免误推（只影响本地）
git tag -d v0.3.0
```

当前工作区修改必须先合入 main，`node scripts/check-versions.mjs` 输出 0.3.1，再针对审核过的 release commit 创建 tag：

```bash
git tag -a v0.3.1 -m "PrismSearch 0.3.1" RELEASE_COMMIT
git push origin v0.3.1
```

以后的版本同理：任何 tag 或版本一旦公开，即使后续发布失败也保留它并发新版本；不要覆盖公开 tag 或复用 npm 版本。
在 **Actions → Release** 观察运行：`verify` / `docker-verify` / `sbom` → `publish-npm` → `publish-images` → `github-release`，并按发布环境要求审批。

- npm 失败：检查 `NPM_TOKEN` 是否为 `release` 环境的 environment secret、是否过期、权限是否足够（账号要求发布 2FA 时还需要 bypass 2FA），修正后在 Actions 页面 **Re-run failed jobs**；
- 镜像失败：先修复并重跑对应门禁或 `publish-images`，不要假设 GitHub Release 已安全发布。

### 6. 配置 npm Trusted Publisher，删除 NPM_TOKEN

首发成功后（工作流使用的 GitHub environment 为 `release`）：

1. npmjs.com → `prismsearch` 包页面 → **Settings** → **Trusted Publisher** → 选择 **GitHub Actions**：
   - Organization or user：`xiaonerner0821`
   - Repository：`prismsearch`
   - Workflow filename：`release.yml`
   - Environment：`release`（必须与发布 job 使用的环境一致）
2. 同一页面的 **Publishing access** 建议改为「Require two-factor authentication and disallow tokens」，
   之后只能通过 Trusted Publishing 发布。
3. 删除 `release` 环境中的 Secret `NPM_TOKEN`（若曾误加为仓库级 Secret，也一并删除），并在 npm 上吊销该 token。

之后的发布无需任何 npm 凭据。Trusted Publishing 要求 npm ≥ 11.5.1，release.yml 已固定安装 `npm@^11.5.1`。

### 7. 把 GHCR 镜像设为 Public 并关联仓库

GHCR 首次推送的包默认是 **Private**，用户无法匿名 `docker pull`。对三个包分别操作：

1. 打开 <https://github.com/xiaonerner0821?tab=packages>，进入包 `prismsearch`；
2. **Package settings** → **Danger Zone** → **Change visibility** → **Public**；
3. 若包页面没有显示关联仓库：**Package settings** → **Manage Actions access / Connect repository**，
   关联 `xiaonerner0821/prismsearch`（镜像的 OCI label `org.opencontainers.image.source` 通常会自动关联）；
4. 对 `prismsearch-ts-worker`、`prismsearch-py-worker` 重复以上步骤。

验证：退出登录状态下执行 `docker pull ghcr.io/xiaonerner0821/prismsearch:0.3.1`。

### 8. 提交到 MCP Registry

`server.json` 已就绪（名称 `io.github.xiaonerner0821/prismsearch`，与 `package.json` 的 `mcpName` 一致）。
Registry 会到 npm 上校验包的 `mcpName`，因此必须在 npm 发布成功之后提交。

```bash
# 安装 mcp-publisher（任选其一，见 https://github.com/modelcontextprotocol/registry）
brew install mcp-publisher
# 或下载对应平台的 release 二进制

mcp-publisher login github     # 浏览器完成 GitHub 设备码授权；io.github.<用户名>/* 命名空间需用该账号登录
mcp-publisher publish          # 在仓库根目录执行，读取 server.json
```

发布后可在 <https://registry.modelcontextprotocol.io/v0/servers?search=prismsearch> 查到。

### 9. 提交到 Smithery 与 awesome-mcp-servers

- **Smithery**：登录 <https://smithery.ai>，用 GitHub 授权后选择 **Add Server / Publish**，
  导入 `xiaonerner0821/prismsearch`，按向导填写启动方式（`npx -y prismsearch`）与可选环境变量
  （`BRAVE_API_KEY`、`GOOGLE_API_KEY`、`GOOGLE_CSE_ID`、`PRISMSEARCH_CONFIG`）。
- **awesome-mcp-servers**：fork <https://github.com/punkpeye/awesome-mcp-servers>，
  在「Search & Data Extraction」分类按字母序加入一行（遵循其 CONTRIBUTING 的格式与图标约定），发 PR。

### 10. 录制 Demo GIF

README 顶部放一段 10～20 秒的演示效果最好，建议内容：在 Claude Desktop / Cursor 等 MCP 客户端中
调用 `web_search`（多引擎聚合结果）→ `fetch_page`（抓取正文为 Markdown）。

- 工具：Windows 用 ScreenToGif，macOS 用 Kap，终端演示可用 asciinema + agg / vhs；
- 尺寸控制在宽 800～1200px、体积 < 5 MB（GitHub README 中过大的 GIF 加载很慢）；
- 放到 `assets/` 下，在 `README.md` 与 `README.zh-CN.md` 中引用；录制前清掉画面中的 API Key 与个人信息。

### 11. 收尾检查

- [ ] npm 包页面显示 provenance 徽标；`npx prismsearch@0.3.1 --version` 输出 `0.3.1`
- [ ] 三个 GHCR 镜像可匿名拉取
- [ ] GitHub Release v0.3.1 的说明与 CHANGELOG 一致
- [ ] README 徽章（CI、npm、Codecov、CodeQL、Scorecard）正常显示；Scorecard 首次结果可能要等一次定时运行
- [ ] Discussions、私密漏洞报告入口可用
- [ ] `NPM_TOKEN` 已删除，Trusted Publisher 已配置
- [ ] 视情况移除 `.github/workflows/links.yml` 中为「发布前 404」临时添加的 exclude

---

## 二、之后每次发版

1. **确定版本号**：遵循语义化版本；可参考 Release Drafter 生成的草稿（Releases 页面中的 Draft）
   对 PR 的分类（`breaking` → 主版本，`feature` → 次版本，其余 → 修订号）。
2. **改版本号**（四处必须一致）：

   ```bash
   npm version X.Y.Z --no-git-tag-version          # package.json 与 package-lock.json
   npm --prefix workers/ts-worker version X.Y.Z --no-git-tag-version
   # 手动修改：workers/py-worker/pyproject.toml 的 version，
   #          server.json 的 version 与 packages[].version
   node scripts/check-versions.mjs                  # 必须通过
   ```

3. **更新 CHANGELOG**：把 `## [未发布]` 下的条目移到新的 `## [X.Y.Z] - YYYY-MM-DD` 标题下
   （保持这个标题格式，release.yml 依赖它提取发布说明），并更新文件末尾的对比链接：

   ```markdown
   [未发布]: https://github.com/xiaonerner0821/prismsearch/compare/vX.Y.Z...HEAD
   [X.Y.Z]: https://github.com/xiaonerner0821/prismsearch/compare/vPREV...vX.Y.Z
   ```

4. **走 PR 合入 main**（例如 `chore(release): vX.Y.Z`），等待 CI 通过。
5. **打 tag 并推送**：

   ```bash
   git switch main && git pull
   git tag vX.Y.Z
   git push origin vX.Y.Z
   ```

6. **发布后**：
   - 删除 Release Drafter 留下的同名草稿（正式 Release 由 release.yml 创建）；
   - 更新 MCP Registry：在仓库根目录执行 `mcp-publisher publish`（登录过期时先 `mcp-publisher login github`）；
   - 预发布版本（如 `1.0.0-rc.1`）会以 `next` 标签发布到 npm，GHCR 不更新 `latest`，GitHub Release 标记为 Pre-release。

### 发布失败怎么办

- **verify 失败**：tag 与版本号不一致、`check-versions` 不通过或 CHANGELOG 缺少该版本段落。
  修正后按新版本发布，或仅在确认尚未发布且规则允许时由授权维护者处理错误 tag；不要强制覆盖公开版本的 tag。
- **npm 已发布但后续 job 失败**：npm 同一版本号不能重复发布，**不要**删 tag 重推，直接在 Actions 中重跑失败的 job。
- **发布了有问题的版本**：npm 上执行 `npm deprecate prismsearch@X.Y.Z "原因"`，然后尽快发修订版；
  除非 72 小时内且无人依赖，否则不要 `npm unpublish`。

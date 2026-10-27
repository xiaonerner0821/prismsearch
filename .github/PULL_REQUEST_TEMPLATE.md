## 变更说明

<!-- 简要描述这个 PR 做了什么、为什么做。关联 Issue 请写：Closes #123 -->

## 变更类型

- [ ] ✨ 新功能（feat）
- [ ] 🐛 Bug 修复（fix）
- [ ] ⚡ 性能（perf）
- [ ] 💥 破坏性变更（标题写 `type!:` 或正文写 `BREAKING CHANGE:`，会自动打 breaking 标签）
- [ ] 📝 文档（docs）
- [ ] ♻️ 重构（refactor）
- [ ] 🔧 构建 / CI / 杂项（chore）

## 自查清单

- [ ] `npm run lint` 通过
- [ ] `npm run typecheck` 通过
- [ ] `npm run build` 通过
- [ ] `npm test` 通过，且新功能包含对应单元测试
- [ ] 新增/变更的配置项已同步更新 `config/default.yaml` 注释与 README
- [ ] 提交信息符合 `type(scope): 描述` 规范
- [ ] 未提交任何 API Key / Token 等凭据
- [ ] 未包含个人敏感信息、真实查询、生产 URL、日志或导出数据
- [ ] 若涉及第三方内容/服务，已确认条款、版权、robots 与许可证边界
- [ ] 用户可见变更已写入 `CHANGELOG.md` 的「未发布」段落
- [ ] `README.md` 与 `README.zh-CN.md` 已同步修改（含 Worker 的 README / README.en）
- [ ] 若改动环境变量、包元数据或版本：已同步 `server.json`，`node scripts/check-versions.mjs` 通过
- [ ] 若改动 Worker 或 Docker：已运行对应 Worker 测试（`workers/ts-worker` 的 `npm test` / `node scripts/py-worker-task.mjs test`），并在 PR 中说明是否验证过镜像构建
- [ ] 若改动安全边界（SSRF、鉴权、Worker 来源、超时/并发上限、日志脱敏）：已补充回归测试，并在 PR 中说明影响

## 测试方式

<!-- 描述你是如何验证这次变更的（本地命令、MCP 客户端实测等） -->

# PrismSearch Docker 多阶段构建
#
# 默认构建为轻量镜像：不包含 Playwright（npm 包与浏览器都不装，体积约 -400MB），
# 浏览器渲染抓取默认关闭。需要渲染时推荐两种方式：
#   1. 启动 TS Worker（docker compose --profile with-workers），由主服务委派渲染请求
#   2. 在本镜像内安装浏览器，见文件末尾说明
#
# 安全：容器内监听 0.0.0.0，服务启动时会强制检查鉴权——
# 未设置 PRISMSEARCH_AUTH_TOKENS（或 security.auth）时直接拒绝启动，不会裸奔暴露。
#
# 基础镜像按 digest 固定（tag 仅便于阅读）。升级时更新 digest：
#   https://hub.docker.com/_/node/tags?name=22-alpine

# 阶段1：安装依赖并构建 TypeScript
FROM node:22-alpine@sha256:fe4f6d74e20370acb04ad889077d14d0f64a9c8ea6a42bc60cddf1e844699914 AS builder
WORKDIR /app
# 没有匹配的预编译包时（如 QEMU 构建 arm64），better-sqlite3 需要从源码编译
RUN apk add --no-cache python3 make g++
# playwright 是可选依赖，镜像内不使用；构建期也不下载浏览器二进制
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY tsconfig.json ./
COPY src/ ./src/
# 构建后裁掉 devDependencies 与可选依赖（目前只有 playwright），
# 剩下的 node_modules 直接拷进运行镜像，运行镜像里不需要编译工具链
RUN npm run build \
    && npm prune --omit=dev --omit=optional \
    && npm cache clean --force

# 阶段2：生产运行环境
FROM node:22-alpine@sha256:fe4f6d74e20370acb04ad889077d14d0f64a9c8ea6a42bc60cddf1e844699914 AS runner
WORKDIR /app

COPY --from=builder /app/package.json ./
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
# 只带随包分发的示例配置，不把本地配置（config/local* 等）打进镜像
COPY config/default.yaml config/http.yaml ./config/
# Apache-2.0 再分发要求附带许可证与 NOTICE
COPY LICENSE NOTICE ./

# 创建数据和日志目录；缓存库放在可挂载的数据目录
RUN mkdir -p /app/data /app/logs

# 创建非root用户
RUN addgroup -g 1001 prismsearch && \
    adduser -u 1001 -G prismsearch -s /bin/sh -D prismsearch && \
    chown -R prismsearch:prismsearch /app

USER prismsearch

# 环境变量
ENV NODE_ENV=production
ENV PRISMSEARCH_HOME=/app/data
ENV PRISMSEARCH_SERVER_TRANSPORT=http
ENV PRISMSEARCH_SERVER_HOST=0.0.0.0
ENV PRISMSEARCH_SERVER_PORT=3000
# 镜像内默认关闭浏览器抓取器（未安装 playwright），HTTP 抓取不受影响
ENV PRISMSEARCH_FETCHER_BROWSER_ENABLED=false

EXPOSE 3000

# 健康检查（/health 无需鉴权）
HEALTHCHECK --interval=30s --timeout=10s --start-period=10s --retries=3 \
  CMD wget -q --spider http://127.0.0.1:3000/health || exit 1

CMD ["node", "dist/index.js"]

# ============================================================
# 可选：在容器内启用浏览器渲染（更推荐用 TS Worker）
# 1. 两个阶段的基础镜像都换成 node:22-bookworm-slim（Chromium 不支持 musl），
#    builder 阶段的 apk add 改为 apt-get install python3 make g++
# 2. builder 阶段去掉 PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD，
#    npm prune 改为只 --omit=dev（保留 playwright）
# 3. runner 阶段追加（需 root，放在 USER prismsearch 之前）：
#      ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
#      RUN npx playwright install --with-deps chromium && \
#          chown -R prismsearch:prismsearch /ms-playwright
# 4. 去掉 PRISMSEARCH_FETCHER_BROWSER_ENABLED=false（或运行时覆盖为 true）
# ============================================================

# PrismSearch TS Worker（Node + Playwright）
#
# 浏览器渲染需要完整的 Chromium 与 glibc 系统依赖，因此不能用 alpine。
# 进程默认只监听回环；本镜像显式设置 WORKER_HOST=0.0.0.0 以便容器网络可达，
# 因此运行时必须设置 PRISMSEARCH_WORKER_TOKEN，否则 Worker 会拒绝启动。
#
# 基础镜像按 digest 固定（tag 仅便于阅读）。升级时更新 digest：
#   https://hub.docker.com/_/node/tags?name=22-bookworm-slim

# ---------- 阶段1：编译 TypeScript ----------
# 不设 NODE_ENV=production：npm ci 需要安装 devDependencies（typescript、@types/node）
FROM node:25-bookworm-slim@sha256:81db02c4b671288a03915da9534dbd54f96d0e7c24d80ccc54f5b36b2e684370 AS build
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# ---------- 阶段2：运行环境 ----------
FROM node:25-bookworm-slim@sha256:81db02c4b671288a03915da9534dbd54f96d0e7c24d80ccc54f5b36b2e684370 AS runtime
ENV NODE_ENV=production \
    PLAYWRIGHT_BROWSERS_PATH=/ms-playwright

WORKDIR /app

# 只装生产依赖（含 optionalDependencies 里的 playwright）
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund \
    && npm cache clean --force

# Chromium 及其系统依赖（需 root，放在切换用户之前）
RUN npx playwright install --with-deps chromium \
    && rm -rf /var/lib/apt/lists/*

COPY --from=build /app/dist ./dist

# 以非 root 运行
RUN useradd --create-home --shell /bin/bash worker \
    && chown -R worker:worker /app /ms-playwright
USER worker

# 容器内需要对外监听；鉴权 token 由运行时注入
ENV WORKER_HOST=0.0.0.0 \
    WORKER_PORT=8787 \
    WORKER_MAX_CONCURRENCY=4

EXPOSE 8787

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
    CMD node -e "fetch('http://127.0.0.1:'+(process.env.WORKER_PORT||8787)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "dist/server.js"]

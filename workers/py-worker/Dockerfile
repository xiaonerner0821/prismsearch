# PrismSearch Python Worker（curl_cffi + trafilatura）
#
# 进程默认只监听回环；本镜像显式设置 WORKER_HOST=0.0.0.0 以便容器网络可达，
# 因此运行时必须设置 PRISMSEARCH_WORKER_TOKEN，否则 Worker 会拒绝启动。
#
# 基础镜像按 digest 固定（tag 仅便于阅读）。升级时更新 digest：
#   https://hub.docker.com/_/python/tags?name=3.12-slim
# 依赖锁文件 requirements.lock 针对 Linux / CPython 3.12 生成，更新方式见 README。

FROM python:3.12-slim@sha256:12316debbfb86890f6b2d825820612741ba527ad5a44e3902759141d572bfe8f AS base
ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1

WORKDIR /app

# 先按锁文件（带 hash 校验）装依赖，利用镜像层缓存；再以 --no-deps 安装本包，
# 保证运行镜像里的依赖版本与锁文件完全一致
COPY requirements.lock ./
RUN python -m venv /opt/venv \
    && /opt/venv/bin/pip install --quiet --require-hashes -r requirements.lock

COPY pyproject.toml ./
COPY py_worker ./py_worker
RUN /opt/venv/bin/pip install --quiet --no-deps . \
    && rm -rf build *.egg-info

ENV PATH="/opt/venv/bin:$PATH"

# 以非 root 运行
RUN useradd --create-home --shell /bin/bash worker
USER worker

# 容器内需要对外监听；鉴权 token 由运行时注入
ENV WORKER_HOST=0.0.0.0 \
    WORKER_PORT=8788 \
    WORKER_MAX_CONCURRENCY=4

EXPOSE 8788

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD python -c "import os,urllib.request,sys; \
url='http://127.0.0.1:%s/health' % os.environ.get('WORKER_PORT','8788'); \
sys.exit(0 if urllib.request.urlopen(url, timeout=4).status == 200 else 1)"

CMD ["python", "-m", "py_worker.server"]

# 部署与运维指南 / Operations Runbook

本文面向公开部署的维护者。命令和配置示例不包含真实令牌；请通过环境变量或密钥管理器注入凭据。

## 上线前检查

- 生产环境优先使用 HTTP + TLS 反向代理；监听非回环地址时设置 `PRISMSEARCH_AUTH_TOKENS`，并限制 `server.allowedHosts` / `server.allowedOrigins`。
- Worker 仅在私有网络监听，设置独立 `PRISMSEARCH_WORKER_TOKEN`；不要把 Worker 端口直接暴露到公网。
- 为缓存、日志和代理配置保留期限；确认 `log.redact` 开启，并将 `PRISMSEARCH_HOME` 放在有访问控制的卷中。
- 配置资源上限：HTTP 速率限制、抓取超时/最大响应体、搜索 deadline、Worker `maxConcurrency`；容器设置 CPU、内存、进程数和临时磁盘上限。
- 运行 `npm run selfcheck`、`npm run verify:pack`，并用无敏感数据的查询完成健康检查和 MCP stdio 握手。

## Caddy 反向代理示例

```caddyfile
search.example.com {
    reverse_proxy 127.0.0.1:3000
    encode gzip
    log {
        output file /var/log/caddy/prismsearch-access.log
        format json
    }
}
```

TLS、访问日志和上游网络策略由部署者负责；不要在日志中记录 `Authorization`，并按组织保留策略轮换日志。

## Nginx 反向代理示例

```nginx
server {
    listen 443 ssl;
    server_name search.example.com;
    client_max_body_size 1m;
    location /mcp {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_read_timeout 120s;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header Authorization $http_authorization;
    }
    location = /health { proxy_pass http://127.0.0.1:3000/health; }
}
```

反向代理应设置受信任的转发头边界、访问控制、TLS 证书自动续期和连接数限制；不要把内部 Worker 路由代理出去。

## 健康、指标与告警

`GET /health` 用于存活检查；它不是鉴权替代品。使用反向代理或编排平台检查 HTTP 状态，并从应用日志/平台指标观察请求成功率、延迟、429/5xx、缓存命中率、Worker 健康状态和在途请求数。不要把查询词、完整 URL、请求头、响应正文、令牌或个人数据作为指标标签。建议为连续健康失败、5xx/429 突增、Worker 全部不可用、内存/磁盘逼近上限设置告警，并保留脱敏后的事件时间线。

## 备份、清理与数据生命周期

缓存不是权威数据，默认 SQLite 可安全在停服后删除；Redis 按部署策略设置 TTL。停止服务后清理 `PRISMSEARCH_HOME` 中的缓存数据库及 WAL 文件、容器卷中的临时抓取数据、代理/反代访问日志和备份副本。删除前先核对路径与保留义务，必要时执行组织规定的安全擦除；不要把生产数据库、日志、导出文件或令牌提交到 Git。若发生敏感数据误写日志，立即限制访问、保留取证副本并按安全流程报告。

## 维护者接替

至少两名维护者应拥有仓库与发布渠道的恢复权限，但不共享个人令牌。交接时更新 CODEOWNERS、GitHub 管理员、npm Trusted Publisher/人工发布环境、GHCR 权限、DNS/TLS、监控与备份联系人；撤销离任者令牌并轮换 Worker、HTTP、API Key。每季度演练从干净环境运行自检、回滚、缓存清理和漏洞报告响应流程，并记录结果。

## 故障处置

先确认 `/health`、日志脱敏状态、资源使用和上游可达性，再区分主服务、Worker、搜索引擎或反代故障。降低并发、启用本地降级或暂时禁用故障引擎时记录变更；不要通过关闭 SSRF、鉴权或 TLS 来“临时修复”。涉及凭据泄露、SSRF、未授权访问或个人数据时，停止扩散并按 [SECURITY.md](../SECURITY.md) 私下报告。

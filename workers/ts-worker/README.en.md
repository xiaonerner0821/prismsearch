# PrismSearch TS Worker

[简体中文](./README.md) | English

A fetch worker built on Node + Playwright, used to render pages that need JavaScript. See [`docs/worker-protocol.md`](../../docs/worker-protocol.md) for the protocol (Chinese).

Capabilities: `["http", "browser"]`. When a request omits `method`, it defaults to `browser`.

## Quick start

```bash
npm ci
npx playwright install chromium   # downloads the browser on first use
npm run build

# Local use only (listens on 127.0.0.1 by default)
WORKER_PORT=8787 npm start

# Serving other hosts: set WORKER_HOST explicitly, together with a token
PRISMSEARCH_WORKER_TOKEN=<long random string> WORKER_HOST=0.0.0.0 npm start
```

For development, `npm run dev` uses Node's native type stripping with file watching.

## Environment variables

| Variable | Default | Description |
| --- | --- | --- |
| `PRISMSEARCH_WORKER_TOKEN` | none | Bearer token. **Without it the worker only binds loopback addresses** and refuses to start otherwise |
| `WORKER_HOST` | `127.0.0.1` | Listen address. Setting a token does not expose the worker by itself; you must set this variable. The Docker image sets it to `0.0.0.0` |
| `WORKER_PORT` | `8787` | Listen port |
| `WORKER_MAX_CONCURRENCY` | `8` | Concurrency limit; excess requests get `429 BUSY` |
| `WORKER_ALLOW_PRIVATE_NETWORK` | `0` | Removed global bypass; any value other than empty or `0` (e.g. `1`, `true`) refuses startup. Global private-network fetching is no longer supported |

The version reported by `/health` is read at runtime from this directory's `package.json`.

## Enabling it in PrismSearch

A Worker is an optional fetch backend, not an MCP server. For cross-host deployment, add its exact origin (without a trailing slash) to the main service's `workers.allowedOrigins`, configure a token, and use HTTPS; only a trusted Docker network may explicitly set endpoint `allowInsecureHttp: true` (default false). Never expose Worker ports publicly. Normal target fetching remains subject to SSRF checks; an origin allowlist does not permit private targets.

```yaml
workers:
  enabled: true
  strategy: least-busy
  useFor: browser        # delegate only requests that need browser rendering
  fallbackToLocal: true  # fall back to local fetching when all workers are down
  endpoints:
    # Without a token field, the main server's PRISMSEARCH_WORKER_TOKEN env var is used
    - name: ts-1
      url: http://127.0.0.1:8787
      weight: 100
      maxConcurrency: 8
```

The config file does not expand `${VAR}`. Do not write `token: ${PRISMSEARCH_WORKER_TOKEN}`; it would be taken as a literal string.

For Docker, see the `with-workers` profile in [`docker/docker-compose.yml`](../../docker/docker-compose.yml).

## Implementation notes

- **SSRF**: every DNS result is checked after URL parsing, and a custom undici `lookup` checks again **at connect time** to block DNS rebinding. In browser mode every subresource request goes through a `page.route` check, and the final URL after redirects is checked again
- **Response size**: the body is streamed and byte-counted; reading stops as soon as the limit is exceeded
- **Browser reuse**: one shared Chromium instance, a new page per request, closed in `finally`
- **Header filtering**: client-supplied `Host`, `Authorization`, `Content-Length` and similar headers are dropped
- **Error messages**: unexpected exceptions return a generic `500 INTERNAL` to the client; details go to the server log

## Tests

```bash
npm run typecheck
npm test
```

Covers SSRF address checks, protocol endpoints, auth failures, private-network rejection and listen-address policy. No real network access is needed.

## License

[Apache-2.0](./LICENSE), the same as the PrismSearch main repository (see the root [`LICENSE`](../../LICENSE)).

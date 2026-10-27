# PrismSearch Python Worker

[简体中文](./README.md) | English

A Python fetch worker with capabilities `["http"]`. When a request omits `method`, it defaults to `http`. It focuses on two things:

- **TLS fingerprint impersonation**: `curl_cffi` reproduces Chrome / Safari handshakes, which survives fingerprint-based anti-bot checks better than plain HTTP clients
- **Content extraction quality**: `trafilatura` extracts the main text, giving cleaner results than selector-only approaches on news, blog and documentation pages

It does not render pages in a browser; send those requests to [`ts-worker`](../ts-worker/). See [`docs/worker-protocol.md`](../../docs/worker-protocol.md) for the protocol (Chinese).

## Quick start

```bash
pip install -e ".[dev]"

# Local use only (listens on 127.0.0.1 by default)
python -m py_worker.server

# Serving other hosts: set WORKER_HOST explicitly, together with a token
PRISMSEARCH_WORKER_TOKEN=<long random string> WORKER_HOST=0.0.0.0 python -m py_worker.server
```

The default port is `8788`, offset from ts-worker's `8787`, so both can run side by side.

## Environment variables

| Variable | Default | Description |
| --- | --- | --- |
| `PRISMSEARCH_WORKER_TOKEN` | none | Bearer token. **Without it the worker only binds loopback addresses** and refuses to start otherwise |
| `WORKER_HOST` | `127.0.0.1` | Listen address. Setting a token does not expose the worker by itself; you must set this variable. The Docker image sets it to `0.0.0.0` |
| `WORKER_PORT` | `8788` | Listen port |
| `WORKER_MAX_CONCURRENCY` | `8` | Concurrency limit; excess requests get `429 BUSY` |
| `WORKER_ALLOW_PRIVATE_NETWORK` | `0` | Removed global bypass; any value other than empty or `0` (e.g. `1`, `true`) refuses startup. Global private-network fetching is no longer supported |

The version reported by `/health` is read at runtime from the installed package metadata (`prismsearch-py-worker`). When running from source without installing, it reports `0.0.0-dev`.

## Enabling it in PrismSearch

A Worker is an optional fetch backend, not an MCP server. For cross-host deployment, add its exact origin (without a trailing slash) to the main service's `workers.allowedOrigins`, configure a token, and use HTTPS; only a trusted Docker network may explicitly set endpoint `allowInsecureHttp: true` (default false). Never expose Worker ports publicly. Normal target fetching remains subject to SSRF checks; an origin allowlist does not permit private targets.

```yaml
workers:
  enabled: true
  strategy: round-robin
  useFor: always        # route plain HTTP fetches through the fingerprinting worker too
  fallbackToLocal: true
  endpoints:
    # Without a token field, the main server's PRISMSEARCH_WORKER_TOKEN env var is used
    - name: py-1
      url: http://127.0.0.1:8788
      weight: 50
      maxConcurrency: 4
```

The config file does not expand `${VAR}`. Do not write `token: ${PRISMSEARCH_WORKER_TOKEN}`; it would be taken as a literal string.

For Docker, see the `with-workers` profile in [`docker/docker-compose.yml`](../../docker/docker-compose.yml).

## Dependency lock

The Docker image installs dependencies from `requirements.lock` (hashed, targeting Linux / CPython 3.12). Regenerate it after changing dependencies in `pyproject.toml`:

```bash
uv pip compile pyproject.toml --generate-hashes --python-version 3.12 --python-platform linux -o requirements.lock
```

## Implementation notes

- **Redirects**: curl_cffi's automatic redirects are disabled; each hop is followed manually and re-validated, since automatic redirects would bypass the SSRF check
- **SSRF**: **every** resolved address is checked, and the request is rejected if any of them is private. Embedded IPv4 in IPv4-mapped, 6to4, Teredo and NAT64 addresses is unpacked and checked as well
- **Fingerprint choice**: an `impersonate` profile is picked by a stable hash of the URL, so repeated fetches of one site keep the same fingerprint
- **Size limit**: the body is streamed and byte-counted; reading stops as soon as the limit is exceeded
- **Extraction fallback**: when `trafilatura` returns nothing, a text-density based container selection takes over so list and doc pages are not lost
- **Error messages**: unexpected exceptions return a generic `500 INTERNAL` to the client; details go to the server log

## Tests

```bash
pytest -q     # 77 tests, all offline
```

From the repository root you can also run `node scripts/py-worker-task.mjs test` / `node scripts/py-worker-task.mjs lint`.

## License

[Apache-2.0](./LICENSE), the same as the PrismSearch main repository (see the root [`LICENSE`](../../LICENSE)).

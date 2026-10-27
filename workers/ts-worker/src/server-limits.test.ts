import { describe, it, expect } from 'vitest';
import { request } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createServer } from './server.js';

describe('worker 请求资源边界', () => {
  it('慢 body 占槽且到期后释放，不影响后续正常请求', async () => {
    const server = createServer({
      host: '127.0.0.1', port: 0, token: 'test', maxConcurrency: 1, allowPrivateNetwork: false,
    }, { bodyTimeoutMs: 250 });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const slow = request(`${base}/v1/fetch`, {
      method: 'POST', headers: { Authorization: 'Bearer test', 'Content-Length': '1000' },
    });
    slow.on('error', () => undefined);
    const closed = new Promise<void>(resolve => slow.once('close', resolve));
    slow.write('{');
    try {
      await expect.poll(async () => (await (await fetch(`${base}/health`)).json()).inFlight).toBe(1);
      const busy = await fetch(`${base}/v1/fetch`, {
        method: 'POST', headers: { Authorization: 'Bearer test' }, body: '{}',
      });
      expect(busy.status).toBe(429);
      await closed;
      await expect.poll(async () => (await (await fetch(`${base}/health`)).json()).inFlight).toBe(0);
      expect((await fetch(`${base}/health`)).status).toBe(200);
    } finally {
      slow.destroy();
      server.closeAllConnections();
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  });
});

import { afterEach, expect, test } from 'vitest';
import { createServer } from 'node:http';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fixture, json } from './fixture.js';
const cleanup = [];
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn(); });
test('ADA-2 steps 1–2: fifty concurrent reservation rounds, dropped reply, same-id retry and permanent gap', async () => {
  const f = await fixture(fn => cleanup.push(fn));
  const requests = [], responses = []; let dropped = false, receiptDropped = false;
  const proxy = createServer(async (req, res) => {
    try {
      let body = ''; for await (const b of req) body += b;
      const command = body ? JSON.parse(body) : null;
      if (req.url.includes('/receipts/') && dropped && !receiptDropped) { receiptDropped = true; req.socket.destroy(); return; }
      const upstream = await fetch(f.url + req.url, { method: req.method, headers: { 'content-type': 'application/json', ...(req.headers.authorization ? { authorization: req.headers.authorization } : {}) }, ...(body ? { body } : {}) });
      const response = await upstream.text();
      if (command?.op === 'reserve') {
        requests.push(command); responses.push(JSON.parse(response));
        if (!dropped) { dropped = true; req.socket.destroy(); return; }
      }
      res.writeHead(upstream.status, { 'content-type': 'application/json' }); res.end(response);
    } catch { res.destroy(); }
  });
  await new Promise(r => proxy.listen(0, '127.0.0.1', r));
  cleanup.push(() => new Promise(r => { proxy.closeAllConnections(); proxy.close(r); }));
  const url = 'http://127.0.0.1:' + proxy.address().port, m = f.machines.felix;
  writeFileSync(join(m.repo, '.crosstalk.toml'), readFileSync(join(m.repo, '.crosstalk.toml'), 'utf8').replace(f.url, url));
  const scope = url + '/' + f.space;
  for (const [file, key] of [['credentials.json', f.keys.felix.agent], ['human-credentials.json', f.keys.felix.human]]) writeFileSync(join(m.home, '.config/crosstalk', file), JSON.stringify({ [scope]: key }), { mode: 0o600 });
  await f.human('felix', ['trust']);
  const values = [];
  for (let round = 0; round < 50; round++) {
    const replies = await Promise.all(['felix', 'dana'].map(n => f.cli(n, ['reserve', 'seq:alembic', '--json'])));
    values.push(...replies.map(r => json(r).result.value));
  }
  expect(values).toHaveLength(100); expect(new Set(values).size).toBe(100); expect(Math.min(...values)).toBe(6);
  expect(values.every(v => v >= 6)).toBe(true);
  expect(dropped).toBe(true); expect(receiptDropped).toBe(true);
  expect(requests[1]).toEqual(requests[0]); expect(responses[1].result.value).toBe(responses[0].result.value); expect(values).toContain(responses[0].result.value);
  json(await f.cli('felix', ['reserve', 'seq:alembic', '--abandon', String(values[0]), '--json']));
  const next = json(await f.cli('dana', ['reserve', 'seq:alembic', '--json'])).result.value;
  expect(next).toBeGreaterThan(Math.max(...values)); expect(next).not.toBe(values[0]);
  console.log('ADA-2: 100 unique allocations; same-id retry and abandoned gap passed');
});

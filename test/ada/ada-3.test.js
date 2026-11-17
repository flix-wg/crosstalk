import { afterEach, expect, test } from 'vitest';
import { readFileSync, writeFileSync, readlinkSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fixture, digest, ok, start, xt, waitFor, quote, json } from './fixture.js';
import { executor } from './executor.js';
const cleanup = [];
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn(); });
test('ADA-3 steps 1–3: enrollment, competing paths and stopped stale deploy after real expiry', async () => {
  const f = await fixture(fn => cleanup.push(fn)), e = await executor(f);
  expect((await e.board()).live.prod).toMatchObject({ live_artifact: digest('0'), exec_seq: 0 });
  // 2: simultaneous laptop and CI claim, inspect the loser rather than assume a winner.
  const race = await Promise.all([['felix', e.a], ['deploy', e.b]].map(([who, s]) => f.command(who, 'lease.claim', { resources: ['env:prod'], ttl_s: 30, note: who + ' deployment' }, {}, s.token)));
  expect(race.filter(r => r.status === 200)).toHaveLength(1);
  const loser = race.find(r => r.status !== 200); expect(JSON.stringify(loser.body)).toContain('conflict');
  for (const field of ['holder', 'note', 'expires_in_s']) expect(JSON.stringify(loser.body)).toContain(field);
  const index = race.findIndex(r => r.status === 200), who = index === 0 ? 'felix' : 'deploy', session = index === 0 ? e.a : e.b;
  const a = race[index].body.result; ok(await e.install(a)); const ta = await e.ticket(who, session, a, digest('a'));
  // 3: stop A's real process before it invokes promote; expiry uses the real clock.
  const launcher = join(e.target, 'paused.sh'); writeFileSync(launcher, `#!/bin/sh\nkill -STOP $$\nexec ${quote(process.execPath)} ${quote(xt)} executor promote prod --ticket ${quote(e.ticketFile(ta))}\n`, { mode: 0o700 });
  const paused = start(launcher, [], { cwd: f.machines.felix.repo, env: e.env });
  cleanup.push(() => { try { process.kill(-paused.p.pid, 'SIGKILL'); } catch { /* exited */ } });
  await waitFor(() => readFileSync(`/proc/${paused.p.pid}/status`, 'utf8').includes('T (stopped)'));
  await sleep(Math.max(0, Date.parse(a.expires_at) - Date.now()) + 100);
  const observed = (await e.board()).leases.find(l => l.lease_id === a.lease_id);
  const b = await e.claim('deploy', e.b, { expect: { lease_id: a.lease_id, rev: observed.rev } }); expect(b.fence).toBeGreaterThan(a.fence);
  ok(await e.install(b)); ok(await e.promoteTicket(await e.ticket('deploy', e.b, b, digest('b'))));
  process.kill(paused.p.pid, 'SIGCONT'); const stale = await paused.done; expect(stale.code).not.toBe(0); expect(stale.output).toContain('stale_fence');
  expect(readlinkSync(join(e.target, 'current'))).toBe('releases/' + digest('b'));
  expect((await e.board()).live.prod).toMatchObject({ live_artifact: digest('b'), exec_seq: 1 });
  console.log('ADA-3: steps 1–3 passed; stale A refused, prod runs B, exec_seq 1');
});
test('ADA-3 step 4: suspended promote refuses busy install without writes, PTY recovery and resume-first variant', async () => {
  const f = await fixture(fn => cleanup.push(fn)), e = await executor(f);
  for (const reconcile of [true, false]) {
    if (!reconcile) { const c = join(e.target, 'prod.toml'); writeFileSync(c, readFileSync(c, 'utf8').replace('timeout_s=2', 'timeout_s=10')); }
    const a = await e.claim('felix', e.a); ok(await e.install(a)); const ta = await e.ticket('felix', e.a, a, digest('a'));
    writeFileSync(e.promote, e.normal + 'kill -STOP $$\n');
    const running = e.promoteTicket(ta); const lockFile = join(e.dir, 'lock.json');
    const lock = await waitFor(() => { const l = JSON.parse(readFileSync(lockFile)); return l.op === ta.payload.op && l.child_pgid && l; });
    cleanup.push(() => { for (const pid of [lock.pgid, lock.child_pgid]) try { process.kill(-pid, 'SIGKILL'); } catch { /* exited */ } });
    await waitFor(() => readFileSync(`/proc/${lock.child_pgid}/status`, 'utf8').includes('T (stopped)'));
    expect(readlinkSync(join(e.target, 'current'))).toBe('releases/' + digest('a'));
    process.kill(lock.pid, 'SIGSTOP'); await e.release('felix', e.a, a); const b = await e.claim('deploy', e.b);
    const files = [join(e.dir, 'state.json'), lockFile, ...readdirSync(join(e.dir, 'ops')).map(n => join(e.dir, 'ops', n))];
    const snapshot = () => files.map(p => ({ contents: readFileSync(p, 'utf8'), mtime: statSync(p).mtimeMs, inode: statSync(p).ino }));
    const before = snapshot(), entries = readdirSync(e.dir, { recursive: true }).sort();
    const installing = e.install(b);
    if (reconcile) expect((await installing).output).toContain('executor_busy');
    else await sleep(100);
    expect(snapshot()).toEqual(before); expect(readdirSync(e.dir, { recursive: true }).sort()).toEqual(entries);
    expect((await e.board()).leases.find(l => l.lease_id === b.lease_id).state).toBe('pending');
    if (reconcile) {
      const busy = JSON.stringify((await e.board()).messages);
      for (const detail of ['executor_busy', String(lock.pid), ta.payload.op, 'age_s']) expect(busy).toContain(detail);
    }
    if (reconcile) {
      const r = await e.human(['reconcile', 'prod']); expect(r.output).toContain(String(lock.pid)); expect(r.output).toContain(ta.payload.op); await running;
      expect(JSON.parse(readFileSync(join(e.dir, 'ops', ta.payload.op + '.json')))).toMatchObject({ outcome: 'reconciled', live_after: digest('a') });
      for (const pid of [lock.pid, lock.child_pgid]) await waitFor(() => { try { return /State:\s+Z/.test(readFileSync(`/proc/${pid}/status`, 'utf8')); } catch { return true; } });
    } else {
      process.kill(lock.child_pgid, 'SIGCONT'); process.kill(lock.pid, 'SIGCONT'); ok(await running); ok(await installing);
    }
    writeFileSync(e.promote, e.normal); ok(await e.install(b)); ok(await e.promoteTicket(await e.ticket('deploy', e.b, b, digest('b'))));
    expect((await e.board()).live.prod.live_artifact).toBe(digest('b')); await e.release('deploy', e.b, b);
  }
  console.log('ADA-3: step 4 recovery and resume-first passed');
});
test('ADA-3 steps 5–8: artifact checks, retries, ordering and exact human approvals', async () => {
  const f = await fixture(fn => cleanup.push(fn)), e = await executor(f), a = await e.claim('felix', e.a); ok(await e.install(a));
  // 5: operator gets exactly A; a faulty operator promoting B is detected by live.
  writeFileSync(e.promote, e.normal.replace('"releases/$1"', '"releases/' + digest('b') + '"'));
  const ta = await e.ticket('felix', e.a, a, digest('a')), wrong = await e.promoteTicket(ta);
  expect(wrong.code).toBe(1); expect(JSON.parse(wrong.stdout)).toMatchObject({ outcome: 'failed', live_after: digest('b') });
  expect(readFileSync(join(e.target, 'runs'), 'utf8').trim()).toBe(digest('a'));
  writeFileSync(e.promote, e.normal); const tb = await e.ticket('felix', e.a, a, digest('b')); ok(await e.promoteTicket(tb));
  // 6
  const runs = readFileSync(join(e.target, 'runs'), 'utf8'); ok(await e.promoteTicket(tb)); expect(readFileSync(join(e.target, 'runs'), 'utf8')).toBe(runs);
  const changed = await e.ticket('felix', e.a, a, digest('c'), tb.payload.op);
  expect((await e.promoteTicket(changed)).output).toContain('idempotency_mismatch');
  // Keep A's terminal report unavailable while B's later report reaches the real relay.
  const { createServer } = await import('node:http');
  const delayed = await e.ticket('felix', e.a, a, digest('a')); let hold = true, attempts = 0;
  const proxy = createServer(async (req, res) => {
    try {
      let body = ''; for await (const chunk of req) body += chunk;
      if (req.url.endsWith('/deploy/report') && JSON.parse(body).op === delayed.payload.op && hold) {
        attempts++; res.writeHead(503); res.end('{}'); return;
      }
      const r = await fetch(f.url + req.url, { method: req.method, headers: { 'content-type': 'application/json', ...(req.headers.authorization ? { authorization: req.headers.authorization } : {}) }, ...(body ? { body } : {}) });
      res.writeHead(r.status, { 'content-type': 'application/json' }); res.end(await r.text());
    } catch { res.destroy(); }
  });
  await new Promise(r => proxy.listen(0, '127.0.0.1', r)); cleanup.push(() => new Promise(r => { proxy.closeAllConnections(); proxy.close(r); }));
  const url = 'http://127.0.0.1:' + proxy.address().port, config = join(e.target, 'prod.toml');
  writeFileSync(config, readFileSync(config, 'utf8').replace(f.url, url));
  const keyFile = join(e.target, 'ci.json'), credentials = JSON.parse(readFileSync(keyFile));
  credentials[url + '/' + f.space] = f.keys['exec-prod'].agent; writeFileSync(keyFile, JSON.stringify(credentials));
  expect((await e.promoteTicket(delayed)).output).toContain('report_pending');
  expect((await e.board()).deployments.some(d => d.op === delayed.payload.op)).toBe(false);
  const later = await e.ticket('felix', e.a, a, digest('b'));
  expect((await e.promoteTicket(later)).output).toContain('report_pending');
  const beforeLate = (await e.board()).live.prod; expect(beforeLate.live_artifact).toBe(digest('b'));
  expect((await e.board()).deployments.some(d => d.op === later.payload.op)).toBe(true);
  hold = false; ok(await e.install(a)); expect(attempts).toBeGreaterThan(0);
  expect((await e.board()).deployments.some(d => d.op === delayed.payload.op)).toBe(true);
  expect((await e.board()).live.prod).toEqual(beforeLate);
  writeFileSync(e.promote, '#!/bin/sh\nexit 1\n'); expect((await e.promoteTicket(await e.ticket('felix', e.a, a, digest('c')))).code).toBe(1);
  expect((await e.board()).live.prod.live_artifact).toBe(digest('b'));
  // 7: ticket issued before the ask must still be rechecked at promote.
  writeFileSync(e.promote, e.normal); const tc = await e.ticket('felix', e.a, a, digest('c'));
  const ask = json(await f.cli('dana', ['ask', 'human:felix', 'Deploy this exact artifact?', '--approval', '--blocks', 'deploy:env:prod', '--head', f.initial, '--artifact', digest('c'), '--json'])).result;
  expect((await e.promoteTicket(tc)).code).not.toBe(0);
  await f.human('felix', ['answer', ask.ask_id, 'approve']); ok(await e.promoteTicket(tc));
  const other = await f.api('felix', '/deploy/ticket', { env: 'prod', sha: f.initial, artifact: digest('a'), lease_id: a.lease_id, fence: a.fence, op: crypto.randomUUID() }, e.a.token); expect(other.status).toBe(200); expect((await e.promoteTicket(other.body.result)).code).not.toBe(0);
  const differentSha = await f.api('felix', '/deploy/ticket', { env: 'prod', sha: f.commit('felix', 'Unapproved SHA'), artifact: digest('c'), lease_id: a.lease_id, fence: a.fence, op: crypto.randomUUID() }, e.a.token);
  expect(differentSha.status).toBe(200); expect((await e.promoteTicket(differentSha.body.result)).code).not.toBe(0);
  for (const action of ['reject', 'cancel']) {
    const requirement = json(await f.cli('dana', ['ask', 'human:felix', 'Allow prod?', '--approval', '--blocks', 'deploy:env:prod', '--head', f.initial, '--artifact', digest('c'), '--json'])).result;
    if (action === 'reject') await f.human('felix', ['answer', requirement.ask_id, 'reject']);
    else ok(await f.cli('dana', ['ask', 'cancel', requirement.ask_id]));
    const input = { env: 'prod', sha: f.initial, artifact: digest('c'), lease_id: a.lease_id, fence: a.fence, op: crypto.randomUUID() };
    const gated = await f.api('felix', '/deploy/ticket', input, e.a.token); expect(gated.status).toBe(200); expect((await e.promoteTicket(gated.body.result)).code).not.toBe(0);
    await f.human('felix', ['ask', 'withdraw', requirement.ask_id, '--reason', 'No longer required']);
    ok(await e.promoteTicket(gated.body.result));
  }
  console.log('ADA-3: steps 5–7 passed; not covered: deploy bypassing the executor');
});

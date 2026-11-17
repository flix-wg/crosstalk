import { mkdirSync, readFileSync, writeFileSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { expect } from 'vitest';
import { digest, quote, ok } from './fixture.js';
export async function executor(f) {
  const target = join(f.root, 'target'), dir = join(target, 'state/prod'); mkdirSync(join(target, 'releases'), { recursive: true });
  for (const c of ['0', 'a', 'b', 'c']) mkdirSync(join(target, 'releases', digest(c)));
  symlinkSync('releases/' + digest('0'), join(target, 'current'));
  const promote = join(target, 'promote'), live = join(target, 'live'), key = join(target, 'ci.json');
  const normal = `#!/bin/sh\nprintf '%s\\n' "$1" >> ${quote(join(target, 'runs'))}\nln -sfn "releases/$1" ${quote(join(target, 'current'))}\n`;
  writeFileSync(promote, normal, { mode: 0o700 });
  writeFileSync(live, `#!/bin/sh\nbasename "$(readlink ${quote(join(target, 'current'))})"\n`, { mode: 0o700 });
  writeFileSync(key, JSON.stringify({ principal: 'ci:exec-prod', [f.machines.felix.scope]: f.keys['exec-prod'].agent }), { mode: 0o600 });
  const conf = readFileSync(join(f.machines.felix.repo, '.crosstalk.toml'), 'utf8').split('[sequences.')[0];
  writeFileSync(join(target, 'prod.toml'), conf + `ci_key="${key}"\npromote="${promote}"\nlive="${live}"\ntimeout_s=2\n`, { mode: 0o600 });
  const env = { ...f.machines.felix.env, CROSSTALK_EXECUTOR_CONFIG_DIR: target, CROSSTALK_EXECUTOR_STATE_DIR: join(target, 'state') };
  const run = (args, options = {}) => f.cli('felix', ['executor', ...args], { env, ...options });
  const human = async args => { expect((await run(args)).output).toContain('tty_required'); return ok(await run(args, { tty: true })); };
  await human(['enroll', 'prod']);
  await f.human('felix', ['env', 'adopt', 'prod', '--sha', f.initial, '--artifact', digest('0')]);
  const a = await f.session('felix'), b = await f.session('deploy');
  const claim = async (who, session, extra = {}) => {
    const r = await f.command(who, 'lease.claim', { resources: ['env:prod'], note: who + ' deploying', ...extra }, {}, session.token);
    expect(r.status, JSON.stringify(r.body)).toBe(200); return r.body.result;
  };
  const release = async (who, session, lease) => expect((await f.command(who, 'lease.release', { lease_id: lease.lease_id }, {}, session.token)).status).toBe(200);
  const install = l => run(['install', 'prod', '--lease', l.lease_id, '--fence', String(l.fence)]);
  const ticket = async (who, session, l, artifact, op = randomUUID()) => {
    const r = await f.api(who, '/deploy/ticket', { env: 'prod', sha: f.initial, artifact, lease_id: l.lease_id, fence: l.fence, op }, session.token);
    expect(r.status, JSON.stringify(r.body)).toBe(200); return r.body.result;
  };
  const ticketFile = t => { const file = join(target, t.payload.op + '.json'); writeFileSync(file, JSON.stringify(t)); return file; };
  const promoteTicket = t => run(['promote', 'prod', '--ticket', ticketFile(t)]);
  const state = () => JSON.parse(readFileSync(join(dir, 'state.json'), 'utf8'));
  const board = async () => (await f.api('deploy', '/board')).body.result;
  return { target, dir, promote, live, normal, env, run, human, a, b, claim, release, install, ticket, ticketFile, promoteTicket, state, board };
}

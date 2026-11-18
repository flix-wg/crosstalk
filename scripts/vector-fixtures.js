// Replayed by both the snapshot writer and the conformance tests.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const id = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
export const actors = ['codex', 'cli', 'mcp'].map((tool, i) => ({ principal: 'human:test', tool, machine: 'test', doing: i ? null : 'Editing API' }));
const walk = (v, f) => typeof v === 'string' ? f(v) : Array.isArray(v) ? v.map(x => walk(x, f))
  : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x, f)])) : v;

export function withSessions(core, openStore, run, list = actors) {
  const store = openStore(':memory:');
  const space = id(1);
  let serial = 100, time = 0;
  const ctx = { epoch: id(2), uuid: () => id(serial++), now: () => time };
  try {
    return store.tx(tx => {
      core.migrate(tx);
      core.createSpace(tx, ctx, space);
      core.bootstrapAdmin(tx, ctx, space, 'human:test', id(3));
      const auth = token => core.authenticate(tx, ctx, space, token);
      core.issueCredential(tx, ctx, auth(id(3)), 'human:test', 'agent', id(4));
      const sessions = list.map(({ tool, machine, doing }, i) => {
        const token = id(5 + i);
        core.openSession(tx, ctx, auth(id(4)), { tool, machine, harness_session_id: tool, worktree: null, head: null, branch: null }, token);
        const actor = auth(token);
        if (doing) core.heartbeat(tx, ctx, actor, 'working', doing);
        return actor;
      });
      return run({ tx, space, sessions, command(actor, now, op, args) {
        time = now;
        const r = core.execute(tx, ctx, sessions[actor], { request_id: ctx.uuid(), op, args });
        return r.error ? { code: r.error.code, ...r.error.details } : r.result;
      } });
    });
  } finally { store.close(); }
}

/** Runs lease steps with `$` placeholders and returns results with every id replaced by its placeholder. */
export function leaseScript(core, openStore, steps, list = actors) {
  return withSessions(core, openStore, ({ sessions, command }) => {
    const names = new Map(), values = new Map();
    const name = (actual, placeholder) => { names.set(actual, placeholder); values.set(placeholder, actual); };
    sessions.forEach(({ session }, i) => {
      name(session, `$session${i}`);
      name(`${list[i].principal.split(':')[1]}/${list[i].tool}/${session.slice(0, 4)}`, `$holder${i}`);
    });
    let leases = 0;
    const neutral = s => names.get(s) ?? (/^[0-9a-f]{8}-[0-9a-f-]{27}$/.test(s) ? (name(s, `$lease${leases++}`), names.get(s)) : s);
    return steps.map(({ actor, now, op, args }) =>
      walk(command(actor, now, op, walk(args, s => values.get(s) ?? s)), neutral));
  }, list);
}

export function deployVerdict(core, openStore, snapshot, input) {
  return withSessions(core, openStore, ({ tx, space }) => {
    const l = snapshot.lease;
    tx.run('INSERT INTO leases VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?)', space, l.lease_id, l.holder,
      JSON.stringify(l.resources), l.state, l.fence, l.rev, l.note, 0, Date.parse(l.expires_at), l.mode);
    tx.run('UPDATE spaces SET frozen=? WHERE space=?', Number(snapshot.frozen), space);
    tx.run('INSERT INTO policies VALUES (?, ?)', space, JSON.stringify(snapshot.policy));
    for (const ask of snapshot.asks) tx.run('INSERT INTO asks VALUES (?, ?, ?, ?)', space, ask.ask_id, 'human:test', JSON.stringify(ask));
    for (const r of snapshot.reachability) tx.run('INSERT INTO reachability VALUES (?, ?, ?)', space, r.ref, r.sha);
    return core.evaluateGate(tx, input).verdict;
  });
}

/** Builds the fixture repository; returns resolveSources plus draftSources per case, oids as their `$` names. */
export function resolveFixture(api, fixture) {
  const dir = mkdtempSync(join(tmpdir(), 'xt-vector-'));
  try {
    const vars = new Map();
    const expand = arg => vars.get(arg) ?? arg;
    for (const { args, save } of fixture.commands) {
      const out = execFileSync('git', args.map(expand), { cwd: dir, encoding: 'utf8', input: '', env: { ...process.env,
        GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', ...fixture.env } }).trim();
      if (save) vars.set(save, out);
    }
    const names = new Map([...vars].map(([k, v]) => [v, k]));
    return fixture.cases.map(({ update, refs, statuses }) => {
      const resolved = { ...update, old: expand(update.old), new: expand(update.new) };
      const tips = new Map(Object.entries(refs).map(([ref, head]) => [ref, expand(head)]));
      const sources = api.resolveSources(dir, resolved, tips, new Set(fixture.protected));
      const all = [...sources, ...api.draftSources(dir, resolved, tips, statuses.map(s => ({ ...s, head: expand(s.head) })), sources)];
      return walk(all, s => names.get(s) ?? s);
    });
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

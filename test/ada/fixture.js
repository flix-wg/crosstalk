import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { randomUUID, randomBytes, createHash, createPublicKey } from 'node:crypto';
import { once } from 'node:events';
import { setTimeout as sleep } from 'node:timers/promises';
import { expect, onTestFailed } from 'vitest';
import { promptMatcher } from '../prompts.js';
export const xt = resolve('dist/cli/main.js'), relayBin = resolve('dist/relay/main.js');
export const quote = s => "'" + s.replaceAll("'", "'\\''") + "'";
export const digest = c => 'sha256:' + c.repeat(64);
export function git(cwd, ...args) { return execFileSync('git', ['-C', cwd, ...args], { env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim(); }
export function start(bin, args, { cwd, env, input, tty = false } = {}) {
  const p = spawn(tty ? 'script' : bin, tty ? ['-qec', [bin, ...args].map(quote).join(' '), '/dev/null'] : args,
    { cwd, env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', ...env }, detached: !tty, stdio: ['pipe', 'pipe', 'pipe'] });
  let output = '', stdout = '', stderr = '';
  const match = promptMatcher(s => p.stdin.write(s));
  const done = new Promise((res, reject) => {
    const timer = setTimeout(() => { p.kill('SIGKILL'); reject(new Error('Process deadline: ' + args.slice(0, 3).join(' '))); }, 120000);
    p.stdout.on('data', b => {
      output += String(b); stdout += String(b);
      if (tty) match(b);
    });
    p.stderr.on('data', b => { output += String(b); stderr += String(b); });
    p.once('error', e => { clearTimeout(timer); reject(e); });
    p.once('close', code => { clearTimeout(timer); res({ code: code ?? 1, output, stdout, stderr }); });
  });
  if (!tty) p.stdin.end(input);
  return { p, done };
}
export const run = (bin, args, opts) => start(bin, args, opts).done;
export function ok(r) { expect(r.code, r.output).toBe(0); return r; }
export function json(r) { ok(r); return JSON.parse(r.stdout); }
export async function waitFor(fn) {
  const end = Date.now() + 15000;
  while (Date.now() < end) { try { const v = fn(); if (v) return v; } catch { /* boundary not yet durable */ } await sleep(20); }
  throw new Error('Timed out waiting for process boundary');
}
export async function fixture(onCleanup) {
  const root = mkdtempSync(join(tmpdir(), 'xt-ada-')), space = randomUUID();
  const keys = Object.fromEntries(['felix', 'dana', 'remote', 'exec-prod', 'deploy'].map(n => [n, { agent: randomBytes(32).toString('hex'), human: randomBytes(32).toString('hex') }]));
  const configFile = join(root, 'relay.json'), database = join(root, 'db'), signingKeyFile = join(root, 'key');
  let relay, url;
  let relayStderr = '';
  const hookStderr = [];
  onTestFailed(({ task }) => {
    const dir = resolve('test-results/ada', task.name.replace(/[^a-zA-Z0-9_-]/g, '_'));
    mkdirSync(dir, { recursive: true });
    const redact = text => Object.values(keys).flatMap(k => Object.values(k)).reduce((s, key) => s.replaceAll(key, '[redacted]'), text);
    writeFileSync(join(dir, 'relay.stderr'), redact(relayStderr));
    writeFileSync(join(dir, 'hooks.stderr'), redact(hookStderr.join('\n')));
  });
  const config = { database, signingKeyFile, host: '127.0.0.1', port: 0, rateLimit: { burst: 10000, perSecond: 10000 }, bootstrap: { space, principal: 'human:felix', humanKey: keys.felix.human, agentKey: keys.felix.agent } };
  async function stop(signal = 'SIGTERM') { if (relay && relay.exitCode === null && relay.signalCode === null) { const closed = once(relay, 'close'); relay.kill(signal); await closed; } }
  onCleanup(async () => { await stop(); rmSync(root, { recursive: true, force: true }); });
  async function boot() {
    writeFileSync(configFile, JSON.stringify(config), { mode: 0o600 });
    relay = spawn(process.execPath, [relayBin, 'serve', configFile], { stdio: ['ignore', 'pipe', 'pipe'] });
    let output = ''; relay.stdout.on('data', b => { output += b; }); relay.stderr.on('data', b => { relayStderr += String(b); });
    await waitFor(() => /Relay listening at (\S+)/.exec(output));
    url = /Relay listening at (\S+)/.exec(output)[1]; config.port = Number(new URL(url).port);
  }
  await boot();
  async function api(who, path, body, token) {
    const r = await fetch(url + '/v1/spaces/' + space + path, { signal: AbortSignal.timeout(10000), method: body === undefined ? 'GET' : 'POST', headers: { authorization: 'Bearer ' + (token ?? keys[who].agent), 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: r.status, body: await r.json() };
  }
  const command = (who, op, args, extra = {}, token) => api(who, '/commands', { request_id: randomUUID(), op, args, ...extra }, token);
  for (const n of ['dana', 'remote', 'exec-prod', 'deploy']) {
    const code = randomBytes(32).toString('hex');
    expect((await api('felix', '/invitations', { request_id: randomUUID(), principal: (n === 'dana' ? 'human:' : 'ci:') + n, role: n === 'dana' ? 'member' : 'ci', code_hash: createHash('sha256').update(code).digest('hex') }, keys.felix.human)).status).toBe(200);
    expect((await api(n, '/enroll', { agentKey: keys[n].agent, humanKey: keys[n].human }, code)).status).toBe(200);
  }
  const pin = 'sha256:' + createHash('sha256').update(createPublicKey(readFileSync(signingKeyFile)).export({ type: 'spki', format: 'der' })).digest('hex');
  const text = `space="${space}"\nrelay="${url}"\nrelay_key="${pin}"\nedit_conflict="ask"\n[sequences.alembic]\nfloor_glob="backend/alembic/versions/*.py"\nfloor_regex="^(\\\\d+)_"\n`;
  const seed = join(root, 'seed'), bare = join(root, 'remote.git'); mkdirSync(seed);
  git(seed, 'init', '-b', 'main'); git(seed, 'config', 'user.name', 'ADA'); git(seed, 'config', 'user.email', 'ada@example.invalid');
  mkdirSync(join(seed, 'backend/alembic/versions'), { recursive: true }); mkdirSync(join(seed, 'api'));
  for (let i = 1; i <= 5; i++) writeFileSync(join(seed, `backend/alembic/versions/000${i}_migration.py`), `revision = '${i}'\n`);
  writeFileSync(join(seed, 'api/schema.py'), 'schema = {}\n'); writeFileSync(join(seed, '.crosstalk.toml'), text);
  git(seed, 'add', '.'); git(seed, 'commit', '-m', 'ADA fixture'); const initial = git(seed, 'rev-parse', 'HEAD'); git(seed, 'branch', 'research-agent');
  git(root, 'clone', '--bare', seed, bare);
  const machines = {};
  for (const n of Object.keys(keys)) {
    const home = join(root, n + '-home'), repo = ['felix', 'dana'].includes(n) ? join(root, n) : bare;
    mkdirSync(join(home, '.config/crosstalk'), { recursive: true });
    if (['felix', 'dana'].includes(n)) { git(root, 'clone', bare, repo); git(repo, 'config', 'user.name', n); git(repo, 'config', 'user.email', n + '@example.invalid'); }
    else writeFileSync(join(bare, '.crosstalk.toml'), text);
    // Credential scope is the public relay/space identity, not a token.
    const { credentialScope, loadConfig } = await import('../../dist/client/index.js');
    const scoped = credentialScope(loadConfig(repo));
    for (const [file, key] of [['credentials.json', keys[n].agent], ['human-credentials.json', keys[n].human]]) writeFileSync(join(home, '.config/crosstalk', file), JSON.stringify({ [scoped]: key }), { mode: 0o600 });
    machines[n] = { home, repo, scope: scoped, env: { HOME: home } };
    ok(await run(process.execPath, [xt, 'trust'], { cwd: repo, env: machines[n].env, tty: true }));
  }
  const cli = async (n, args, opts = {}) => {
    const result = await run(process.execPath, [xt, ...args], { cwd: machines[n].repo, env: machines[n].env, ...opts });
    if (args[0] === 'hook') hookStderr.push(n + ' ' + args.slice(0, 3).join(' ') + '\n' + result.stderr);
    return result;
  };
  const human = async (n, args) => { expect((await cli(n, args)).output).toContain('tty_required'); return ok(await cli(n, args, { tty: true })); };
  await human('felix', ['admin', 'policy', 'set', '--protected-branch', 'main']);
  await human('felix', ['hook', 'git', 'seed', 'main']);
  for (const hook of ['pre-receive', 'post-receive']) writeFileSync(join(bare, 'hooks', hook), `#!/bin/sh\nHOME=${quote(machines.remote.home)} exec ${quote(process.execPath)} ${quote(xt)} hook git ${hook}\n`, { mode: 0o700 });
  const push = async (n, ...refs) => {
    const result = await run('git', ['push', bare, ...refs], { cwd: machines[n].repo, env: machines[n].env });
    hookStderr.push(n + ' git push\n' + result.stderr);
    return result;
  };
  const commit = (n, label) => { git(machines[n].repo, 'commit', '--allow-empty', '-m', label); return git(machines[n].repo, 'rev-parse', 'HEAD'); };
  const recorded = JSON.parse(readFileSync(new URL('./fixtures/hooks.json', import.meta.url), 'utf8'));
  const hook = async (n, event, overrides = {}) => {
    const harness = n === 'felix' ? 'claude-code' : 'codex';
    const input = recorded.find(f => f.harness === harness && f.input.hook_event_name === event)?.input ?? { hook_event_name: event };
    const result = await cli(n, ['hook', harness, event], { input: JSON.stringify({ ...input, cwd: machines[n].repo, session_id: n + '-recorded', ...overrides }) });
    return result;
  };
  const session = async n => {
    const r = await api(n, '/sessions', { tool: n === 'deploy' ? 'ci' : 'cli', harness_session_id: randomUUID(), machine: n, worktree: machines[n].repo, branch: null, head: null });
    expect(r.status).toBe(200); return r.body.result;
  };
  return { root, space, keys, configFile, database, boot, stop, api, command, machines, cli, human, hook, push, commit, bare, initial, session, get relay() { return relay; }, get url() { return url; } };
}

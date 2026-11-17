import { afterEach, expect, test } from 'vitest';
import { fixture, git, ok, json } from './fixture.js';
const cleanup = [];
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn(); });
test('ADA-4 steps 1–6: durable review, human authority, three G2 pushes, two approvals and audit tamper', async () => {
  const f = await fixture(fn => cleanup.push(fn)), repo = f.machines.dana.repo;
  git(repo, 'switch', '-c', 'gateway-route'); const g1 = f.commit('dana', 'G1'); ok(await f.push('dana', 'gateway-route'));
  // 1
  ok(await f.hook('dana', 'SessionStart'));
  const ask = json(await f.cli('dana', ['ask', 'human:felix', 'Public route to unauthenticated gateway OK?', '--approval', '--blocks', 'merge:branch:gateway-route', '--json'])).result;
  expect(ask).toMatchObject({ bound_head: g1, state: 'open' });
  // 2
  ok(await f.hook('dana', 'SessionEnd'));
  expect((await f.api('remote', '/board')).body.result.presence.find(p => p.principal === 'human:dana' && p.tool === 'codex').state).toBe('offline');
  const fresh = await f.hook('felix', 'SessionStart', { session_id: 'fresh-felix' }); expect(fresh.output).toContain('Public route to unauthenticated gateway OK?');
  // 3
  const denied = json(await f.hook('felix', 'PreToolUse', { tool_name: 'Bash', tool_input: { command: `xt answer ${ask.ask_id} approve` } })).hookSpecificOutput;
  expect(denied.permissionDecision).toBe('deny');
  const unauthorized = await f.command('felix', 'ask.answer', { ask_id: ask.ask_id, choice: 'approve' }, { expect_rev: 1 }); expect(JSON.stringify(unauthorized.body)).toContain('not_authorized');
  // 4
  ok(await f.hook('dana', 'SessionStart')); await f.human('felix', ['answer', ask.ask_id, 'approve']);
  const prompt = await f.hook('dana', 'UserPromptSubmit');
  expect(prompt.output).toContain('approve');
  ok(await f.push('dana', g1 + ':refs/heads/main'));
  const g2 = f.commit('dana', 'G2'); ok(await f.cli('dana', ['branch', 'ready']));
  const together = await f.push('dana', 'gateway-route', g2 + ':refs/heads/main'); expect(together.code).not.toBe(0); expect(together.output).toContain('Waiting for');
  const unknown = await f.push('dana', g2 + ':refs/heads/main'); expect(unknown.code).not.toBe(0); expect(unknown.output).toContain('Unknown merge source');
  git(repo, 'switch', 'main'); git(repo, 'merge', '--no-ff', 'gateway-route', '-m', 'merge G2');
  const parent = await f.push('dana', 'main'); expect(parent.code).not.toBe(0); expect(parent.output).toContain('Unknown merge source');
  await f.human('felix', ['answer', ask.ask_id, 'approve', '--reaffirm', '--head', g2]);
  ok(await f.push('dana', 'gateway-route', g2 + ':refs/heads/main'));
  // 5
  const second = json(await f.cli('felix', ['ask', 'human:dana', 'Second review?', '--approval', '--blocks', 'merge:branch:gateway-route', '--head', g2, '--json'])).result;
  const check = () => f.cli('dana', ['check', 'merge', '--branch', 'gateway-route', '--head', g2, '--target', 'main', '--json']);
  expect((await check()).code).toBe(3); expect((await f.push('dana', 'main')).code).not.toBe(0); await f.human('dana', ['answer', second.ask_id, 'approve']); expect(json(await check()).result.verdict).toBe('pass'); ok(await f.push('dana', 'main'));
  // 6
  ok(await f.cli('remote', ['audit', 'export'])); ok(await f.cli('remote', ['audit', 'verify']));
  const ref = 'refs/crosstalk/audit/v1', paths = git(f.bare, 'ls-tree', '-r', '--name-only', ref).split('\n'), events = paths.find(p => p.endsWith('.jsonl'));
  expect(events).toBeTruthy(); const contents = git(f.bare, 'show', ref + ':' + events); expect(contents).toContain('Public route'); expect(contents).toContain('decision'); expect(contents).toContain(ask.ask_id);
  // Rewrite an exported event through real Git plumbing, retaining the signed head.
  const blob = await import('./fixture.js').then(({ run }) => run('git', ['hash-object', '-w', '--stdin'], { cwd: f.bare, input: contents.replace('Public route', 'Tampered route') + '\n' })); ok(blob);
  const tree = git(f.bare, 'rev-parse', ref + '^{tree}');
  const { run } = await import('./fixture.js');
  const index = f.root + '/audit-index'; const env = { GIT_INDEX_FILE: index };
  ok(await run('git', ['read-tree', tree], { cwd: f.bare, env }));
  ok(await run('git', ['update-index', '--cacheinfo', '100644,' + blob.output.trim() + ',' + events], { cwd: f.bare, env }));
  const changedTree = ok(await run('git', ['write-tree'], { cwd: f.bare, env })).output.trim();
  const commit = ok(await run('git', ['-c', 'user.name=ADA', '-c', 'user.email=ada@example.invalid', 'commit-tree', changedTree, '-p', git(f.bare, 'rev-parse', ref), '-m', 'tamper fixture'], { cwd: f.bare })).output.trim(); git(f.bare, 'update-ref', ref, commit);
  expect((await f.cli('remote', ['audit', 'verify'])).code).not.toBe(0);
  console.log('ADA-4: steps 1–6 passed, including all three G2 push forms and tamper detection');
});
test('A4: edit overlap asks Claude Code and denies Codex with a reason', async () => {
  const f = await fixture(fn => cleanup.push(fn));
  ok(await f.cli('felix', ['claim', 'tree:api/']));
  for (const n of ['felix', 'dana']) {
    ok(await f.hook(n, 'SessionStart'));
    const r = json(await f.hook(n, 'PreToolUse', { tool_name: n === 'felix' ? 'Edit' : 'apply_patch', tool_input: { file_path: 'api/schema.py', old_string: '{}', new_string: '{1:2}', command: '*** Begin Patch\n*** Update File: api/schema.py\n*** End Patch' } })).hookSpecificOutput;
    expect(r.permissionDecision).toBe(n === 'felix' ? 'ask' : 'deny'); expect(r.permissionDecisionReason).toContain('Path lease conflict'); expect(r.permissionDecisionReason).toContain('developer');
  }
  console.log('A4: Claude Code ask and Codex deny passed');
});

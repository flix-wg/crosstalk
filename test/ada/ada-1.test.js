import { afterEach, test, expect } from 'vitest';
import { fixture, git, json, ok } from './fixture.js';
const cleanup = [];
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn(); });
test('ADA-1 steps 1–6: draft awareness, server enforcement, override notice and stale readiness', async () => {
  const f = await fixture(fn => cleanup.push(fn)), felix = f.machines.felix.repo, dana = f.machines.dana.repo;
  git(felix, 'switch', 'research-agent'); const h1 = f.commit('felix', 'H1'); ok(await f.push('felix', 'research-agent'));
  // 1
  expect(json(await f.cli('felix', ['branch', 'draft', '--pending', 'fix wave 1497db8', '--json'])).result).toMatchObject({ state: 'draft' });
  // 2
  const digest = (await f.hook('dana', 'SessionStart')).output;
  for (const text of ['research-agent', 'draft', 'felix', 'fix wave 1497db8']) expect(digest.toLowerCase()).toContain(text);
  git(dana, 'fetch', f.bare, 'research-agent:refs/remotes/origin/research-agent');
  // 3
  const denied = json(await f.hook('dana', 'PreToolUse', { tool_name: 'Bash', tool_input: { command: 'git merge origin/research-agent' } })).hookSpecificOutput;
  expect(denied.permissionDecision).toBe('deny'); for (const text of ['draft', 'felix', 'fix wave 1497db8']) expect(denied.permissionDecisionReason).toContain(text);
  const warning = json(await f.hook('dana', 'PreToolUse', { tool_name: 'Bash', tool_input: { command: 'git switch -c feature origin/research-agent' } })).hookSpecificOutput;
  expect(warning.permissionDecision).toBeUndefined(); expect(warning.additionalContext).toContain('warn');
  // 4
  git(dana, 'merge', '--no-ff', 'origin/research-agent', '-m', 'merge with local hooks off');
  const rejected = await f.push('dana', 'main'); expect(rejected.code).not.toBe(0); expect(rejected.output).toContain('research-agent');
  // 5
  ok(await f.hook('felix', 'SessionStart'));
  await f.human('felix', ['override', 'merge', '--branch', 'research-agent', '--head', h1, '--reason', 'Reviewed draft intentionally']);
  ok(await f.push('dana', 'main'));
  const main = git(dana, 'rev-parse', 'HEAD');
  ok(await f.cli('remote', ['hook', 'git', 'post-receive'], { input: `${f.initial} ${main} refs/heads/main\n` }));
  const inbox = json(await f.cli('felix', ['inbox', '--json']));
  expect(inbox.result.messages.filter(m => JSON.stringify(m).includes('became reachable'))).toHaveLength(1);
  expect((await f.hook('felix', 'UserPromptSubmit')).output).toContain('became reachable');
  // 6
  const h2 = f.commit('felix', 'H2'); ok(await f.push('felix', 'research-agent')); ok(await f.cli('felix', ['branch', 'ready']));
  expect(json(await f.cli('dana', ['check', 'merge', '--branch', 'research-agent', '--head', h2, '--target', 'main', '--json'])).result.verdict).toBe('pass');
  expect(json(await f.cli('dana', ['check', 'merge', '--branch', 'research-agent', '--head', h1, '--target', 'main', '--json'])).result.verdict).toBe('warn');
  console.log('ADA-1: steps 1–6 passed');
});

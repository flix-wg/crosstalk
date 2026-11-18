// Portable examples generated from the reference implementation. Never use the TEST-ONLY key outside tests.
import { mkdirSync, writeFileSync } from 'node:fs';
import { createPrivateKey, createPublicKey } from 'node:crypto';
import { jcs, eventHash, GENESIS_PREV_HASH, canonicalKey, foldKey, overlaps, sign } from '../dist/schema/index.js';
import { migrate, createSpace, evaluateGate } from '../dist/core/index.js';
import { openStore } from '../dist/store-sqlite/index.js';
import * as core from '../dist/core/index.js';
import * as sources from '../dist/client/merge-gate.js';
import { id, actors, withSessions, leaseScript, deployVerdict, resolveFixture } from './vector-fixtures.js';

const dir = 'test-vectors/2.0';
mkdirSync(dir, { recursive: true });
const write = (name, value) => writeFileSync(`${dir}/${name}.json`, JSON.stringify(value, null, 2) + '\n');

const space = id(1), epoch = id(2), head = 'a'.repeat(40), next = 'b'.repeat(40);
// input_json preserves negative zero, which JSON.stringify would otherwise erase.
const canonical = ['{"z":"é😀","a":"e\\u0301"}', '{"large":1e21,"negative_zero":-0,"small":1e-7,"decimal":0.1}', '{"z":{"b":2,"a":1},"a":[{"y":true,"x":null}]}'];
write('canonical-json', canonical.map(input_json => ({ input_json, jcs: jcs(JSON.parse(input_json)) })));
let prev = GENESIS_PREV_HASH;
const events = [1, 2, 3].map(seq => {
  const input = { v: 2, space, epoch, seq, id: id(seq + 2), request_id: null, recorded_at: `2026-11-17T00:00:0${seq}.000Z`, actor: { principal: 'ci:relay', via: 'relay' }, git: { branch: null, head: null }, prev_hash: prev, body: { type: 'admin', action: seq === 2 ? 'gates_unfrozen' : 'gates_frozen' } };
  const hash = eventHash(prev, input); prev = hash;
  return { input, hash };
});
write('event-hash', { chain: events, invalid: [
  { name: 'tampered body', previous: GENESIS_PREV_HASH, ...events[0], input: { ...events[0].input, body: events[1].input.body } },
  { name: 'wrong previous hash', previous: GENESIS_PREV_HASH, ...events[1] },
] });
write('resource-keys', {
  canonical: ['tree:api', 'path:cafe\u0301/file', 'branch:Topic', 'env:prod', 'seq:build_1', 'path:a/../b', 'tree:/', 'path:a//b', 'env:Prod', 'res:two words', 'path:a\\b'].map(input => {
    let output; try { output = canonicalKey(input); } catch { output = 'invalid_resource'; } return { input, output };
  }),
  fold: ['path:Straße', 'path:STRASSE', 'path:ς', 'path:Σ', 'tree:API/İ', 'path:a/ς', 'path:aσ', 'path:ﬁle', 'path:K', 'path:ı'].map(input => ({ input, output: foldKey(input) })),
  overlap: [['tree:API', 'path:api/x'], ['tree:api', 'path:apix/x'], ['path:Straße', 'path:STRASSE'], ['path:ς', 'path:σ'], ['path:a/ς', 'path:a/σ'], ['path:Ᲊ', 'path:ᲊ'], ['branch:Topic', 'branch:topic'], ['branch:topic', 'path:topic'], ['seq:build', 'seq:build'], ['tree:a/b', 'tree:A'], ['env:prod', 'env:stage']].map(([a, b]) => ({ a, b, output: overlaps(a, b) })),
});
// RFC 8032 test key #1; public, deterministic and TEST ONLY.
const seed_hex = '9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60';
const key = createPrivateKey({ key: Buffer.from('302e020100300506032b657004220420' + seed_hex, 'hex'), format: 'der', type: 'pkcs8' });
const nonce = '0123456789abcdef0123456789abcdef';
const payload = { kind: 'deploy_ticket', space, epoch, env: 'prod', sha: head, artifact: 'sha256:' + 'a'.repeat(64), lease_id: id(8), fence: 7, op: id(9), holder: id(10), principal: 'human:test', expires_at: 1794874200000 };
const signed = bytes => ({ bytes_utf8: bytes, bytes_hex: Buffer.from(bytes).toString('hex'), signature_base64: sign(bytes, key).toString('base64') });
write('signatures', { warning: 'TEST ONLY: public fixed key; NEVER use for real credentials or relay signing.', seed_hex, public_key_raw_hex: createPublicKey(key).export({ format: 'der', type: 'spki' }).subarray(-32).toString('hex'), hello: { nonce, ...signed('crosstalk-hello:' + nonce) }, deploy_ticket: { payload, ...signed(jcs(payload)) } });
const branch = (state = 'ready', bound = head) => ({ type: 'branch_status', branch: 'work', state, head: bound, owner: 'human:test', rev: 1 });
const ask = (state = 'open', bound = head, rev = state === 'open' ? 1 : 2) => ({ type: 'ask', ask_id: id(20), kind: 'approval', state, rev, to: 'human:test', question: 'Ship?', blocks: ['merge:branch:work'], bound_head: bound });
const decision = (verdict, bound = head, source = 'ask') => ({ type: 'decision', decision_id: id(30), source: { kind: source, id: id(20) }, verdict, bound_head: bound, scope: ['merge:branch:work'], decided_by: 'human:test' });
const input = { kind: 'merge', space, now: 0, source_branch: 'work', source_head: head, target_branch: 'main' };
const cases = [
  ['draft', branch('draft')], ['ready', branch()], ['stale', branch('ready', next)], ['unknown status', null],
  ['unknown source', null, [], [], {}, { kind: 'merge', space, now: 0, source_head: head, target_branch: 'main', unknown_source: true }],
  ['unknown source target requirement', null, [{ ...ask(), blocks: ['merge:target:main'] }], [], { gates: { merge: { unknown_source: 'pass' } } }, { kind: 'merge', space, now: 0, source_head: head, target_branch: 'main', unknown_source: true }],
  ['open requirement', branch(), [ask()]],
  ['approved requirement', branch(), [ask('answered')], [decision('approve')]],
  ['latest reject', branch(), [ask('answered', head, 3)], [decision('approve'), decision('reject')]],
  ['reject then approve new head', branch('ready', next), [ask('answered', next, 3)], [decision('reject'), decision('approve', next)], {}, { ...input, source_head: next }],
  ['old head no longer approved', branch(), [ask('answered', next, 3)], [decision('approve'), decision('approve', next)]],
  ['withdrawn requirement', branch(), [ask('withdrawn')]],
  ['override draft', branch('draft'), [], [decision('approve', head, 'override')]],
  ['override cannot satisfy requirement', branch('draft'), [ask()], [decision('approve', head, 'override')]],
  ['strict stale policy', branch('ready', next), [], [], { gates: { merge: { stale_ready: 'block' } } }],
];
const vectors = cases.map(([name, branch_status, asks = [], decisions = [], policy = {}, gateInput = input]) => {
  // Decisions are oldest first; their array position gives increasing event sequence.
  decisions = decisions.map((d, i) => ({ ...d, decision_id: id(30 + i) }));
  const snapshot = { branch_status, asks, decisions, policy };
  const store = openStore(':memory:');
  try {
    const verdict = store.tx(tx => {
      migrate(tx); createSpace(tx, { now: () => 0, uuid: () => id(99), epoch }, space);
      if (branch_status) tx.run('INSERT INTO branch_status VALUES (?, ?, ?)', space, 'work', JSON.stringify(branch_status));
      tx.run('INSERT INTO policies VALUES (?, ?)', space, JSON.stringify(policy));
      for (const a of asks) tx.run('INSERT INTO asks(space, ask_id, asker, body) VALUES (?, ?, ?, ?)', space, a.ask_id, 'human:test', JSON.stringify(a));
      decisions.forEach((d, i) => tx.run('INSERT INTO decisions VALUES (?, ?, ?, ?)', space, d.decision_id, i + 1, JSON.stringify(d)));
      return evaluateGate(tx, gateInput).verdict;
    });
    return { name, snapshot, input: gateInput, verdict };
  } finally { store.close(); }
});
write('merge-gate', { decision_order: 'oldest first (increasing event seq)', cases: vectors });

const exclusive = { resources: ['tree:api/'], ttl_s: 30 };
const shared = { resources: ['path:api/index'], mode: 'shared', note: 'Reviewing' };
const takeover = { lease_id: '$lease0', rev: 2 };
const script = [
  ['exclusive claim', 0, 0, 'lease.claim', exclusive],
  ['renew', 0, 1000, 'lease.claim', exclusive],
  ['conflict', 1, 2000, 'lease.claim', exclusive],
  ['shared beside exclusive', 1, 2000, 'lease.claim', shared],
  ['steal after expiry beside shared', 2, 31000, 'lease.claim', { ...exclusive, expect: takeover }],
  ['shared rejects env', 1, 31000, 'lease.claim', { ...shared, resources: ['env:prod'] }],
  ['shared rejects expect', 1, 31000, 'lease.claim', { ...shared, expect: takeover }],
  ['exclusive ttl over 900', 1, 31000, 'lease.claim', { ...exclusive, ttl_s: 901 }],
  ['release', 2, 31000, 'lease.release', { lease_id: '$lease2' }],
].map(([name, actor, now, op, args]) => ({ name, actor, now, op, args }));
const results = leaseScript(core, openStore, script);
write('leases', {
  placeholders: '$sessionN and $holderN (display form) name the session of actor N; $leaseN names the Nth new lease_id in result order.',
  actors: actors.map((a, i) => ({ ...a, session: `$session${i}`, holder: `$holder${i}` })),
  steps: script.map((step, i) => ({ ...step, expected: results[i] })),
});

const lease = withSessions(core, openStore, ({ command }) => {
  const { lease_id, holder, resources, mode, state, fence, rev, note, expires_at } = command(0, 0, 'lease.claim', { resources: ['env:prod'] });
  return { lease_id, holder, resources, mode, state, fence, rev, note, expires_at };
});
const deploy = { kind: 'deploy', space, now: 0, env: 'prod', sha: head, artifact: payload.artifact, holder: lease.holder, lease_id: lease.lease_id, fence: lease.fence };
const requireOn = { envs: { prod: { require_on: 'main' } } };
const deployCases = [
  ['held lease'], ['wrong fence', { fence: 2 }], ['wrong holder', { holder: id(90) }], ['expired', { now: 300000 }],
  ['unsatisfied requirement', {}, { asks: [{ ...ask(), blocks: ['deploy:env:prod'], bound_artifact: payload.artifact }] }],
  ['require_on reachable', {}, { policy: requireOn, reachability: [{ ref: 'main', sha: head }] }],
  ['require_on not reachable', {}, { policy: requireOn, reachability: [{ ref: 'main', sha: next }] }],
  ['frozen', {}, { frozen: true }],
].map(([name, delta, change]) => {
  const snapshot = { lease, frozen: false, asks: [], policy: {}, reachability: [], ...change }, input = { ...deploy, ...delta };
  return { name, snapshot, input, verdict: deployVerdict(core, openStore, snapshot, input) };
});
write('deploy-gate', { cases: deployCases });

const commands = [{ args: ['init', '-q', '--bare', '--object-format=sha1', '-b', 'main'] }, { args: ['mktree'], save: '$tree' }];
for (const [tip, ...parents] of [['base'], ['b1', 'base'], ['b2', 'b1'], ['a', 'b2'], ['merge', 'base', 'b2']]) {
  commands.push({ args: ['commit-tree', '$tree', ...parents.flatMap(p => ['-p', '$' + p]), '-m', tip], save: '$' + tip });
}
const status = (name, state, at) => ({ ...branch(state, at), branch: name });
const b = { 'refs/heads/B': '$b2' };
const sourceCases = [
  ['direct tip', '$b2', b], ['merge parent', '$merge', b], ['unknown', '$a', {}],
  ['queue ignored', '$a', { 'refs/heads/gh-readonly-queue/main/q': '$a' }],
  ['draft ancestry despite unknown source', '$a', {}, [status('A', 'wip', '$b1')]],
  ['stacked draft without own commits still blocks', '$merge', { ...b, 'refs/heads/A': '$b1' }, [status('B', 'ready', '$b2'), status('A', 'wip', '$b2')]],
].map(([name, tip, refs, statuses = []]) => ({ name, update: { ref: 'refs/heads/main', old: '$base', new: tip }, refs, statuses }));
const env = { GIT_AUTHOR_NAME: 'vector', GIT_COMMITTER_NAME: 'vector', GIT_AUTHOR_EMAIL: 'vector@example.org',
  GIT_COMMITTER_EMAIL: 'vector@example.org', GIT_AUTHOR_DATE: '2000-01-01T00:00:00Z', GIT_COMMITTER_DATE: '2000-01-01T00:00:00Z' };
const fixture = { protected: ['main'], env, commands, cases: sourceCases };
const expected = resolveFixture(sources, fixture);
write('source-resolution', { ...fixture, cases: sourceCases.map((item, i) => ({ ...item, expected: expected[i] })) });

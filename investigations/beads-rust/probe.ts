import { appendFileSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import assert from 'node:assert/strict';

// Fixture-only capability probe. Does not dispatch agents or touch a real store.
const evidenceRoot = resolve(import.meta.dir, '../../.investigation/br-comparison');
mkdirSync(evidenceRoot, { recursive: true });
const root = mkdtempSync(join(evidenceRoot, 'fixture-'));
const binary = process.env.SWITCHBOARD_BR_BINARY
  ? resolve(process.env.SWITCHBOARD_BR_BINARY)
  : join(evidenceRoot, 'br');
for (const dir of ['home', 'config', 'tmp', 'main', 'other']) mkdirSync(join(root, dir));
const cwd = join(root, 'main');
const beads = join(cwd, '.beads');
const db = join(beads, 'beads.db');
const baseEnv = { PATH: process.env.PATH ?? '', HOME: join(root, 'home'), XDG_CONFIG_HOME: join(root, 'config'), TMPDIR: join(root, 'tmp'), NO_COLOR: '1' };
const checks: Record<string, unknown> = { recordedAt: new Date().toISOString(), version: '0.7.6', bun: Bun.version, root, binary, db };
async function run(args: string[], options: { cwd?: string, beads?: string, db?: string, failure?: boolean, noSyncFlags?: boolean } = {}) {
  const cmd = [binary, '--db', options.db ?? db, '--actor', 'switchboard-probe', '--json', ...(options.noSyncFlags ? [] : ['--no-auto-import', '--no-auto-flush']), ...args];
  const child = Bun.spawn(cmd, { cwd: options.cwd ?? cwd, env: { ...baseEnv, BEADS_DIR: options.beads ?? beads }, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe', timeout: 15000 });
  const [stdout, stderr, exitCode] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  const record = { cmd, cwd: options.cwd ?? cwd, beads: options.beads ?? beads, exitCode, stdout, stderr };
  appendFileSync(join(root, 'commands.jsonl'), JSON.stringify(record) + '\n');
  if (exitCode !== 0 && !options.failure) throw new Error(JSON.stringify(record, null, 2));
  return { exitCode, stdout, stderr, json: stdout.trim() ? JSON.parse(stdout) : null };
}
function issue(value: any) { return Array.isArray(value) ? value[0] : value; }
async function create(title: string, extra: string[] = []) { return issue((await run(['create', title, ...extra])).json); }
async function show(id: string, options: Parameters<typeof run>[1] = {}) { return issue((await run(['show', id], options)).json); }
async function ready() { const v = (await run(['ready'])).json; return (Array.isArray(v) ? v : v.issues).map((i: any) => i.id); }

try {
  await run(['init', '--prefix', 'sb']);
  checks.initialEmptyReady = await ready();
  assert.deepEqual(checks.initialEmptyReady, []);
  const body = 'Instructions: keep all work\n\nUnicode α and "quotes"';
  const ac = '- [ ] Evidence retained\n- [ ] Required review completed';
  const worker = await create('Worker', ['--description', body, '--acceptance-criteria', ac]);
  const dependent = await create('Dependent');
  await run(['dep', 'add', dependent.id, worker.id]);
  assert.deepEqual(await ready(), [worker.id]);
  const blockedClaim = await run(['update', dependent.id, '--claim'], { failure: true });
  checks.blockedClaim = { exitCode: blockedClaim.exitCode, statusAfter: (await show(dependent.id)).status };
  assert.notEqual(blockedClaim.exitCode, 0);
  assert.equal((await show(dependent.id)).status, 'open');

  await run(['update', worker.id, '--claim']);
  assert.equal((await show(worker.id)).status, 'in_progress');
  assert.equal((await ready()).includes(worker.id), false);
  const before = await show(worker.id);
  const nextAction = JSON.stringify({ taskId: worker.id, leaseId: 'fixture-lease', sessionId: 'fixture-session', branch: 'output', resultCommit: 'a'.repeat(40), reason: 'Review required', nextAction: 'Review retained branch' });
  await run(['update', worker.id, '--status', 'deferred', '--append-notes', nextAction, '--if-unchanged', before.updated_at]);
  const held = await show(worker.id);
  assert.equal(held.status, 'deferred');
  assert.equal(held.description, body);
  assert.equal(held.acceptance_criteria, ac);
  assert.match(held.notes, /Review retained branch/);
  assert.equal((await ready()).includes(worker.id), false);
  assert.equal((await ready()).includes(dependent.id), false);
  checks.hold = { status: held.status, preservesInstructionsAndAcceptance: true, retainsWorkReferences: true, excludesTaskAndDependent: true };

  const staleUpdate = await run(['update', worker.id, '--title', 'Must not apply', '--if-unchanged', before.updated_at], { failure: true });
  assert.equal(staleUpdate.exitCode, 6);
  assert.equal((await show(worker.id)).title, 'Worker');
  checks.staleUpdate = { exitCode: staleUpdate.exitCode, unchanged: true };

  const proofFromOtherCwd = await show(worker.id, { cwd: join(root, 'other') });
  assert.equal(proofFromOtherCwd.id, worker.id);
  checks.explicitAddressingFromOtherCwd = true;

  const blocker = await create('Unfinished blocker');
  const paused = await create('Paused independently');
  await run(['dep', 'add', paused.id, blocker.id]);
  await run(['defer', paused.id, '--transition-comment', 'Indefinite operator hold']);
  await run(['close', blocker.id, '--reason', 'Fixture accepted']);
  assert.equal((await show(paused.id)).status, 'deferred');
  assert.equal((await ready()).includes(paused.id), false);
  checks.dependencyCompletionDoesNotReleaseHold = true;

  const parent = await create('Parent requires separate review', ['--type', 'epic']);
  await run(['defer', parent.id]);
  const child = await create('Only child', ['--parent', parent.id]);
  await run(['close', child.id, '--reason', 'Fixture child accepted']);
  const parentAfter = await show(parent.id);
  assert.equal(parentAfter.status, 'deferred');
  checks.childCompletionDoesNotAutoCloseParent = { statusAfter: parentAfter.status };

  const acceptance = await create('Explicitly accepted independent deliverable');
  await run(['update', acceptance.id, '--claim']);
  await run(['close', acceptance.id, '--reason', 'Accepted independent artefact', '--transition-comment', JSON.stringify({ summary: 'Fixture done', evidence: ['Check passed'], branch: 'retained', commit: 'b'.repeat(40) })]);
  const closed = await show(acceptance.id);
  assert.equal(closed.status, 'closed');
  checks.completionReadback = { status: closed.status, details: closed };

  const routedWorkspace = join(root, 'routed-workspace');
  mkdirSync(routedWorkspace);
  const routedBeads = join(routedWorkspace, '.beads');
  const routedDb = join(routedBeads, 'beads.db');
  const routedOptions = { cwd: routedWorkspace, beads: routedBeads, db: routedDb };
  await run(['init', '--prefix', 'foreign'], routedOptions);
  const routedIssue = issue((await run(['create', 'Foreign fixture task'], routedOptions)).json);
  writeFileSync(join(beads, 'routes.jsonl'), JSON.stringify({ prefix: 'foreign-', path: routedWorkspace }) + '\n');
  await run(['update', routedIssue.id, '--append-notes', 'Routed even with explicit primary --db']);
  const routedAfter = await show(routedIssue.id, routedOptions);
  assert.match(routedAfter.notes, /Routed even with explicit primary --db/);
  checks.routingCanOverrideExplicitDb = { confirmed: true, foreignFixtureOnly: true, requestedDb: db, actualDb: routedDb };

  const caps = (await run(['capabilities'])).json;
  assert.equal(caps.version, '0.7.6', 'Reassess the contracts before testing another release');
  checks.capabilities = caps;
  checks.info = (await run(['info'])).json;
  checks.schema = (await run(['schema', 'issue'])).json;
  checks.completed = true;
} finally {
  writeFileSync(join(evidenceRoot, 'results.json'), JSON.stringify(checks, null, 2) + '\n');
}
console.log(JSON.stringify({ ...checks, schema: 'Saved full schema in results.json', capabilities: { version: (checks.capabilities as any).version, build_features: (checks.capabilities as any).build_features }, info: { engine: (checks.info as any).engine.name, engineVersion: (checks.info as any).engine.version, database_path: (checks.info as any).database_path } }, null, 2));

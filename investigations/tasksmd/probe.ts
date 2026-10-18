import { appendFileSync, chmodSync, mkdirSync, mkdtempSync, renameSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import assert from 'node:assert/strict';

// Fixture-only capability probe of the tasks.md git-native backend. Does not dispatch agents or touch a real store.
const version = '0.10.2';
const evidenceRoot = resolve(import.meta.dir, '../../.investigation/tasksmd-comparison');
mkdirSync(evidenceRoot, { recursive: true });
const root = mkdtempSync(join(evidenceRoot, 'fixture-'));
const cli = resolve(import.meta.dir, 'node_modules/@tasks-md/cli/dist/cli.js');
const node = process.env.SWITCHBOARD_NODE ?? Bun.which('node');
const realGit = Bun.which('git');
if (!node || !realGit) throw new Error('node and git are required on PATH');
for (const dir of ['home', 'config', 'tmp', 'outside', 'shim']) mkdirSync(join(root, dir));
const origin = join(root, 'origin.git');
const store = join(root, 'store');
const other = join(root, 'other');
const worktree = join(root, 'worktree');
const baseEnv = {
  PATH: process.env.PATH ?? '', HOME: join(root, 'home'), XDG_CONFIG_HOME: join(root, 'config'), TMPDIR: join(root, 'tmp'),
  NO_COLOR: '1', GIT_CONFIG_NOSYSTEM: '1', TASKS_INSTANCE: 'probe',
};
const observed: Record<string, unknown> = {};

type Run = { cwd?: string; actor?: string; path?: string };
async function spawn(cmd: string[], options: Run & { kind: string }) {
  const cwd = options.cwd ?? store;
  const env = { ...baseEnv, TASKS_ACTOR: options.actor ?? 'switchboard', PATH: options.path ?? baseEnv.PATH };
  const child = Bun.spawn(cmd, { cwd, env, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe', timeout: 60000 });
  const [stdout, stderr, exitCode] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  appendFileSync(join(root, 'commands.jsonl'), JSON.stringify({ kind: options.kind, cmd, cwd, actor: env.TASKS_ACTOR, exitCode, stdout, stderr }) + '\n');
  return { exitCode, stdout, stderr };
}
async function git(cwd: string, ...args: string[]) {
  const out = await spawn([realGit!, ...args], { cwd, kind: 'git' });
  if (out.exitCode !== 0) throw new Error(`git ${args.join(' ')} failed: ${out.stderr}`);
  return out.stdout.trim();
}
/** Runs the CLI and keeps the exit code; tasks.md reports refusals as JSON with a nonzero exit. */
async function tasks(args: string[], options: Run = {}) {
  const out = await spawn([node!, cli, ...args, '--json'], { ...options, kind: 'tasks' });
  let json: any = null;
  try { json = out.stdout.trim() ? JSON.parse(out.stdout) : null; } catch { /* Keep raw output in the command log. */ }
  return { ...out, json };
}
const list = async (options: Run = {}) => (await tasks(['list'], options)).json as any[];
const find = (items: any[], id: string) => items.find(item => item.id === id);
async function events(cwd: string) {
  const names = (await git(cwd, 'ls-tree', '--name-only', 'tasks-claims', 'events/')).split('\n').filter(Boolean);
  return Promise.all(names.map(async name => JSON.parse(await git(cwd, 'show', `tasks-claims:${name}`))));
}

try {
  // Fixture: a bare origin, the authoritative store clone, a second clone for a competing writer, and a worktree of
  // the store standing in for a Treehouse workspace.
  await git(root, 'init', '-q', '--bare', '-b', 'main', origin);
  await git(root, 'init', '-q', '-b', 'main', store);
  for (const [key, value] of [['user.name', 'Switchboard probe'], ['user.email', 'probe@example.invalid']]) await git(store, 'config', key!, value!);
  writeFileSync(join(store, '.tasksmd.json'), '{ "backend": "git-native" }\n');
  writeFileSync(join(store, 'README.md'), '# Fixture\n');
  await git(store, 'add', '.');
  await git(store, 'commit', '-q', '-m', 'Fixture');
  await git(store, 'remote', 'add', 'origin', origin);
  await git(store, 'push', '-q', 'origin', 'main');
  await git(root, 'clone', '-q', origin, other);

  observed.emptyList = await list();
  assert.deepEqual(observed.emptyList, []);

  const body = 'Instructions: keep all work\n\nAcceptance:\n- [ ] Evidence retained\n\nUnicode α and "quotes"';
  const worker = (await tasks(['create', 'Worker task', '--priority', 'P1', '--body', body])).json;
  await tasks(['create', 'Dependent task', '--blocked-by', worker.id]);
  await tasks(['create', 'Lower priority task', '--priority', 'P3']);
  await tasks(['create', 'Race task', '--priority', 'P0']);
  observed.createdIds = (await list()).map(task => task.id);
  observed.idsComeFromTitles = worker.id === 'worker-task';

  // Readiness and refusal of a blocked claim.
  const blocked = await tasks(['claim', 'dependent-task']);
  observed.blockedClaim = { status: blocked.json?.status, exitCode: blocked.exitCode };

  // Two clones claim the same task concurrently from the same starting state.
  await tasks(['list'], { cwd: other, actor: 'competitor' });
  const [mine, theirs] = await Promise.all([
    tasks(['claim', 'race-task']), tasks(['claim', 'race-task'], { cwd: other, actor: 'competitor' }),
  ]);
  const raceEvents = (await events(store)).filter(event => event.task_id === 'race-task' && event.event_type === 'claimed');
  observed.concurrentClaim = {
    statuses: [mine.json?.status, theirs.json?.status], exitCodes: [mine.exitCode, theirs.exitCode],
    exactlyOneClaimed: [mine, theirs].filter(r => r.json?.status === 'claimed').length === 1,
    claimedEventsInLog: raceEvents.length,
  };

  // Claim, fencing token and lease.
  const claim = (await tasks(['claim', worker.id])).json;
  const claimed = find(await list(), worker.id);
  observed.claim = {
    status: claim.status, claimIdVisibleToEveryReader: claimed.claimId === claim.claimId,
    leaseHours: Math.round((claimed.leaseExpiresAt - Date.now()) / 36e5), pickAfterClaim: (await tasks(['pick'])).json,
  };
  const foreignClaim = await tasks(['claim', worker.id], { cwd: other, actor: 'competitor' });
  observed.liveClaimRefusedForOtherActor = { status: foreignClaim.json?.status, exitCode: foreignClaim.exitCode };
  const staleComplete = await tasks(['complete', worker.id, '--claim', 'claim-stale']);
  const staleUpdate = await tasks(['update', worker.id, '--title', 'Must not apply', '--claim', 'claim-stale']);
  observed.fencing = {
    staleComplete: { status: staleComplete.json?.status, exitCode: staleComplete.exitCode },
    staleUpdate: { status: staleUpdate.json?.status, exitCode: staleUpdate.exitCode },
    stillOpenAndUnchanged: find(await list(), worker.id)?.title === 'Worker task',
  };

  // The token is only checked when supplied: another actor omits it while Switchboard holds a live claim.
  await tasks(['create', 'Fenced task']);
  const fenced = (await tasks(['claim', 'fenced-task'])).json;
  const noTokenComplete = await tasks(['complete', 'fenced-task'], { cwd: other, actor: 'competitor' });
  const updateAfterForeignCompletion = await tasks(['update', 'fenced-task', '--blocked', 'awaiting-review', '--claim', fenced.claimId]);
  observed.tokenOptional = {
    otherActorCompleteWithoutToken: { status: noTokenComplete.json?.status, exitCode: noTokenComplete.exitCode },
    taskClosedByOtherActor: !find(await list(), 'fenced-task'),
    ownerUpdateAfterForeignCompletion: { status: updateAfterForeignCompletion.json?.status, exitCode: updateAfterForeignCompletion.exitCode },
  };

  // Hold: worker finished but review remains. Record the reason and work references, then give up the claim.
  const references = JSON.stringify({ leaseId: 'fixture-lease', sessionId: 'fixture-session', branch: 'attempt/1', resultCommit: 'a'.repeat(40) });
  const hold = await tasks(['update', worker.id, '--blocked', `awaiting-review – ${references}`, '--claim', claim.claimId]);
  const release = await tasks(['unclaim', worker.id, '--claim', claim.claimId]);
  const held = find(await list(), worker.id);
  observed.hold = {
    updateStatus: hold.json?.status, updateExit: hold.exitCode, releaseStatus: release.json?.status, releaseExit: release.exitCode,
    blockedReasonRetained: held?.blocked?.includes(resultCommitOf(references)), unclaimed: held?.assignee === undefined,
    bodyUnchanged: held?.body === body, pickSkipsHeldTask: (await tasks(['pick'])).json?.id !== worker.id,
    claimRefusedWhileHeld: (await tasks(['claim', worker.id])).json?.status,
    dependentStillBlocked: (await tasks(['claim', 'dependent-task'])).json?.status === 'blocked',
  };

  // Store addressing: the CLI has no store path option and resolves everything from the working directory.
  const outside = await tasks(['list'], { cwd: join(root, 'outside') });
  const forced = await tasks(['list', '--backend', 'git-native'], { cwd: join(root, 'outside') });
  observed.listFromNonRepositoryDirectory = {
    default: { exitCode: outside.exitCode, stdout: outside.stdout.trim(), stderr: outside.stderr.trim().slice(0, 300) },
    forcedGitNative: { exitCode: forced.exitCode, stdout: forced.stdout.trim(), stderr: forced.stderr.trim().slice(0, 300) },
  };

  // A worktree of the store repository shares refs/heads/tasks-claims, so a worker can change the store directly.
  await git(store, 'worktree', 'add', '-q', '-b', 'attempt/1', worktree);
  const fromWorktree = await tasks(['claim', 'lower-priority-task'], { cwd: worktree, actor: 'worker' });
  observed.worktree = {
    sharesClaimsRef: (await git(worktree, 'rev-parse', 'tasks-claims')) === (await git(store, 'rev-parse', 'tasks-claims')),
    workerClaimFromWorktree: fromWorktree.json?.status,
    visibleInAuthoritativeStore: find(await list(), 'lower-priority-task')?.assignee,
  };
  await tasks(['unclaim', 'lower-priority-task', '--claim', fromWorktree.json?.claimId ?? ''], { cwd: worktree, actor: 'worker' });

  // Completion record: complete takes no summary or evidence; check what remains readable afterwards.
  const raceOwner = mine.json?.status === 'claimed' ? { cwd: store, actor: 'switchboard', claimId: mine.json.claimId } : { cwd: other, actor: 'competitor', claimId: theirs.json?.claimId };
  await tasks(['update', 'race-task', '--body', 'Outcome: completed; evidence: tests passed', '--claim', raceOwner.claimId], raceOwner);
  const complete = await tasks(['complete', 'race-task', '--claim', raceOwner.claimId], raceOwner);
  const raceAfter = (await events(store)).filter(event => event.task_id === 'race-task');
  observed.completion = {
    status: complete.json?.status, exitCode: complete.exitCode, absentFromList: !find(await list(), 'race-task'),
    eventsStillInLog: raceAfter.map(event => event.event_type),
  };
  const compact = await spawn([node!, cli, 'fleet', 'compact', '--force'], { kind: 'tasks' });
  observed.compaction = {
    exitCode: compact.exitCode, raceTaskEventsAfter: (await events(store)).filter(event => event.task_id === 'race-task').length,
    heldTaskSurvives: !!find(await list(), worker.id),
  };

  // Lost acknowledgement: the push reaches origin but git reports failure once.
  const marker = join(root, 'shim', 'fail-next-push');
  writeFileSync(join(root, 'shim', 'git'), `#!/bin/sh\n"${realGit}" "$@"; code=$?\nif [ "$1" = push ] && [ -f "${marker}" ]; then rm -f "${marker}"; exit 1; fi\nexit $code\n`);
  chmodSync(join(root, 'shim', 'git'), 0o755);
  const shimPath = `${join(root, 'shim')}:${baseEnv.PATH}`;
  writeFileSync(marker, '');
  const lostUpdate = await tasks(['update', worker.id, '--priority', 'P0'], { path: shimPath });
  const lowerClaim = (await tasks(['claim', 'lower-priority-task'])).json;
  writeFileSync(marker, '');
  const lostComplete = await tasks(['complete', 'lower-priority-task', '--claim', lowerClaim.claimId], { path: shimPath });
  await git(other, 'fetch', '-q', 'origin', '+tasks-claims:tasks-claims');
  const originEvents = await events(other);
  observed.lostAcknowledgement = {
    update: { exitCode: lostUpdate.exitCode, status: lostUpdate.json?.status, eventsInOrigin: originEvents.filter(e => e.task_id === worker.id && e.event_type === 'updated' && e.payload.priority === 'P0').length },
    complete: { exitCode: lostComplete.exitCode, status: lostComplete.json?.status, eventsInOrigin: originEvents.filter(e => e.task_id === 'lower-priority-task' && e.event_type === 'completed').length },
  };
  writeFileSync(marker, '');
  await tasks(['create', 'Lost claim task']);
  const lostClaim = await tasks(['claim', 'lost-claim-task'], { path: shimPath });
  observed.lostAcknowledgement = {
    ...observed.lostAcknowledgement as object,
    claim: { exitCode: lostClaim.exitCode, status: lostClaim.json?.status, assigneeAfter: find(await list(), 'lost-claim-task')?.assignee },
  };

  // Origin unavailable: does a read report failure or return the local copy? Does a write stay local?
  const before = (await list()).map(task => task.id);
  renameSync(origin, `${origin}.away`);
  const offlineList = await tasks(['list']);
  const offlineClaim = await tasks(['claim', 'dependent-task']);
  const offlineCreate = await tasks(['create', 'Created while offline']);
  const localAfter = await list();
  renameSync(`${origin}.away`, origin);
  await git(other, 'fetch', '-q', 'origin', '+tasks-claims:tasks-claims');
  const otherView = await list({ cwd: other, actor: 'competitor' });
  observed.originUnavailable = {
    list: { exitCode: offlineList.exitCode, returnedLocalCopy: JSON.stringify(offlineList.json?.map((t: any) => t.id)) === JSON.stringify(before) },
    claimOfBlockedTask: { exitCode: offlineClaim.exitCode, status: offlineClaim.json?.status },
    create: { exitCode: offlineCreate.exitCode, stderr: offlineCreate.stderr.trim().slice(0, 300) },
    unpushedTaskVisibleLocally: !!find(localAfter, 'created-while-offline'),
    unpushedTaskVisibleElsewhere: !!find(otherView, 'created-while-offline'),
  };
  const reconnected = await list();
  observed.originUnavailable = { ...observed.originUnavailable as object, unpushedTaskAfterReconnectFetch: !!find(reconnected, 'created-while-offline') };

  const result = {
    recordedAt: new Date().toISOString(), version, bun: Bun.version, node: (await spawn([node!, '--version'], { kind: 'node' })).stdout.trim(),
    git: (await git(root, '--version')), root, observed,
  };
  writeFileSync(join(evidenceRoot, 'results.json'), JSON.stringify(result, null, 2) + '\n');
  console.log(JSON.stringify(result, null, 2));
} catch (error) {
  console.error(`Probe failed. Command log: ${join(root, 'commands.jsonl')}`);
  console.error(JSON.stringify(observed, null, 2));
  throw error;
}

function resultCommitOf(value: string): string { return JSON.parse(value).resultCommit; }

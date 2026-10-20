import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { resolvePolicy, type ForgeFact, type PolicySources } from "../../src/dispatch/policy.ts";
import { describeStatus, status } from "../../src/dispatch/status.ts";
import { onPath } from "../../src/infra/executables.ts";
import { githubRepository } from "../../src/infra/github.ts";
import { fixture, task } from "./fixture.ts";

// Phase 2 PRD, finishing an attempt: built-in policy kinds chosen from global, repository and context layers.

type Fixture = Awaited<ReturnType<typeof fixture>>;
const repository = (f: Fixture) => join(f.dir, "repository");
function sources(f: Fixture, overrides: Partial<PolicySources> = {}): PolicySources {
  return { git: onPath("git"), environment: f.environment, repository: repository(f), baseRef: "main", globalFile: join(f.dir, "global-policy.json"), context: {}, ...overrides };
}
function commitPolicy(f: Fixture, policy: unknown, branch = "main") {
  if (branch !== "main") f.run(["switch", "-q", "-c", branch]);
  mkdirSync(join(repository(f), ".switchboard"), { recursive: true });
  writeFileSync(join(repository(f), ".switchboard", "policy.json"), JSON.stringify(policy));
  f.run(["add", ".switchboard/policy.json"]);
  f.run(["commit", "-q", "--no-gpg-sign", "-m", `Policy on ${branch}`]);
  if (branch !== "main") f.run(["switch", "-q", "main"]);
}

test("with no policy documents the policy is manual, from the default layer", async () => {
  const f = await fixture();
  assert.deepEqual(await resolvePolicy(sources(f)), { kind: "manual", sources: { kind: "default" }, forbidden: [] });
});

test("each layer overrides the one before, and the resolved policy records which layer set each part", async () => {
  const f = await fixture();
  writeFileSync(join(f.dir, "global-policy.json"), JSON.stringify({ kind: "local-merge" }));
  let resolved = await resolvePolicy(sources(f));
  assert.deepEqual([resolved.kind, resolved.targetBranch, resolved.sources], ["local-merge", "main", { kind: "global", targetBranch: "default" }]);

  commitPolicy(f, { targetBranch: "integration" });
  resolved = await resolvePolicy(sources(f));
  assert.deepEqual([resolved.kind, resolved.targetBranch, resolved.sources], ["local-merge", "integration", { kind: "global", targetBranch: "repository" }]);

  resolved = await resolvePolicy(sources(f, { context: { kind: "manual" } }));
  assert.deepEqual([resolved.kind, resolved.targetBranch, resolved.sources], ["manual", undefined, { kind: "context" }]);
});

test("operator layers can forbid a kind, and the repository file cannot select it or forbid anything", async () => {
  const f = await fixture();
  writeFileSync(join(f.dir, "global-policy.json"), JSON.stringify({ forbid: ["local-merge"] }));
  commitPolicy(f, { kind: "local-merge" });
  const refused = await resolvePolicy(sources(f));
  assert.match(refused.refusal ?? "", /forbidden by the global layer/);
  assert.equal((await resolvePolicy(sources(f, { context: { kind: "manual" } }))).refusal, undefined);
  assert.match((await resolvePolicy(sources(f, { globalFile: join(f.dir, "none.json"), context: { forbid: ["local-merge"] } }))).refusal ?? "", /forbidden by the context layer/);

  commitPolicy(f, { kind: "manual", forbid: ["manual"] });
  await assert.rejects(resolvePolicy(sources(f, { globalFile: join(f.dir, "none.json") })), /repository policy .* is invalid/);
});

test("the repository file is read only from the base branch, never from another branch or a working tree", async () => {
  const f = await fixture({ tasks: [task("policy-a1")] });
  commitPolicy(f, { kind: "manual" });
  commitPolicy(f, { kind: "local-merge" }, "switchboard/policy-a1/attempt-1");
  // The backing repository has another branch checked out, with an uncommitted edit on top, and a leased workspace
  // has the same edit.
  f.run(["switch", "-q", "switchboard/policy-a1/attempt-1"]);
  writeFileSync(join(repository(f), ".switchboard", "policy.json"), JSON.stringify({ kind: "local-merge" }));
  const lease = await f.deps.workspaces.acquire({ holder: "policy-a1", baseRef: "main", branch: "switchboard/policy-a1/attempt-2" });
  writeFileSync(join(lease.path, ".switchboard", "policy.json"), JSON.stringify({ kind: "local-merge" }));
  const resolved = await resolvePolicy(sources(f));
  assert.deepEqual([resolved.kind, resolved.sources.kind], ["manual", "repository"]);
});

test("invalid documents and an unreadable base branch are errors, not silently skipped", async () => {
  const f = await fixture();
  writeFileSync(join(f.dir, "global-policy.json"), "{ not json");
  await assert.rejects(resolvePolicy(sources(f)), /global policy .* is not valid JSON/);
  writeFileSync(join(f.dir, "global-policy.json"), JSON.stringify({ kind: "push-to-production" }));
  await assert.rejects(resolvePolicy(sources(f)), /global policy .* is invalid/);
  await assert.rejects(resolvePolicy(sources(f, { globalFile: join(f.dir, "none.json"), baseRef: "no-such-branch" })), /cannot be read/);
});

test("forge facts refuse local-merge into a protected branch, are reported when unknown, and are not read for manual", async () => {
  const f = await fixture();
  const asked: string[] = [];
  const forge = (fact: ForgeFact) => async (branch: string) => { asked.push(branch); return fact; };
  const local = { context: { kind: "local-merge" as const, targetBranch: "main" } };
  assert.match((await resolvePolicy(sources(f, { ...local, forge: forge({ protected: true }) }))).refusal ?? "", /main is protected/);
  assert.equal((await resolvePolicy(sources(f, { ...local, forge: forge({ protected: false }) }))).refusal, undefined);
  const unknown = await resolvePolicy(sources(f, { ...local, forge: forge({ unknown: "no gh" }) }));
  assert.deepEqual([unknown.refusal, unknown.forgeUnknown], [undefined, "no gh"]);
  asked.length = 0;
  await resolvePolicy(sources(f, { forge: forge({ protected: true }) }));
  assert.deepEqual(asked, []);
});

test("GitHub remotes are recognised in their usual forms, and other hosts are not", () => {
  for (const url of ["https://github.com/owner/repo.git", "https://github.com/owner/repo", "git@github.com:owner/repo.git", "ssh://git@github.com/owner/repo.git"]) {
    assert.equal(githubRepository(url), "owner/repo", url);
  }
  assert.equal(githubRepository("https://gitlab.com/owner/repo.git"), undefined);
  assert.equal(githubRepository("https://github.com.evil.example/owner/repo.git"), undefined);
});

test("status shows the resolved policy, and asks for attention when it cannot be resolved", async () => {
  const f = await fixture();
  writeFileSync(join(f.dir, "global-policy.json"), JSON.stringify({ kind: "local-merge" }));
  const view = await status({ ...f.deps, policy: sources(f) });
  assert.deepEqual(view.policy && "resolved" in view.policy ? view.policy.resolved.kind : undefined, "local-merge");
  assert.match(describeStatus(view), /Finalisation policy: local-merge \(from the global layer\) into main/);
  writeFileSync(join(f.dir, "global-policy.json"), "{");
  const broken = await status({ ...f.deps, policy: sources(f) });
  assert.equal(broken.reason, "attention");
  assert.ok(broken.policy && "error" in broken.policy);
});

test("Phase 2 review finding 3: a tag with the base branch's name cannot supply the repository policy", async () => {
  const f = await fixture();
  commitPolicy(f, { kind: "manual" });
  commitPolicy(f, { kind: "local-merge" }, "switchboard/policy-a1/attempt-1");
  f.run(["tag", "main", "switchboard/policy-a1/attempt-1"]);
  const resolved = await resolvePolicy(sources(f, { globalFile: join(f.dir, "none.json") }));
  assert.deepEqual([resolved.kind, resolved.sources.kind], ["manual", "repository"]);
});

test("Phase 2 review finding 7: a committed policy file that cannot be read is an error, not an absent layer", async () => {
  const f = await fixture();
  commitPolicy(f, { kind: "local-merge" });
  const blob = f.run(["rev-parse", "main:.switchboard/policy.json"]);
  rmSync(join(repository(f), ".git", "objects", blob.slice(0, 2), blob.slice(2)), { force: true });
  await assert.rejects(resolvePolicy(sources(f, { globalFile: join(f.dir, "none.json") })), /cannot be read|Could not read/);
});

test("Phase 2 review finding 7: a base commit whose policy directory cannot be read is an error, not an absent layer", async () => {
  const f = await fixture();
  commitPolicy(f, { kind: "local-merge" });
  const tree = f.run(["rev-parse", "main:.switchboard"]);
  rmSync(join(repository(f), ".git", "objects", tree.slice(0, 2), tree.slice(2)), { force: true });
  await assert.rejects(resolvePolicy(sources(f, { globalFile: join(f.dir, "none.json") })), /cannot be read/);
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { checkRetention, type RetentionRequest } from "../../src/workspaces/retention.ts";
import { onPath } from "../../src/infra/executables.ts";

// Uses plain Git worktrees in disposable repositories; retention does not depend on Treehouse.
const git = onPath("git");
const evidence = resolve(import.meta.dirname, "../../.investigation/retention-unit");
mkdirSync(evidence, { recursive: true });

function fixture() {
  const dir = realpathSync(mkdtempSync(join(evidence, "case-")));
  const environment = {
    PATH: process.env.PATH ?? "", HOME: dir, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_AUTHOR_NAME: "Switchboard fixture", GIT_AUTHOR_EMAIL: "fixture@example.invalid",
    GIT_COMMITTER_NAME: "Switchboard fixture", GIT_COMMITTER_EMAIL: "fixture@example.invalid",
  };
  const repository = join(dir, "repository");
  const workspace = join(dir, "workspace");
  const run = (args: string[], cwd = repository) => execFileSync(git, ["-c", "core.hooksPath=/dev/null", ...args], { cwd, env: environment, encoding: "utf8" }).trim();
  mkdirSync(repository);
  run(["init", "-q", "-b", "main"]);
  writeFileSync(join(repository, ".gitignore"), "cache/\n");
  writeFileSync(join(repository, "tracked.txt"), "base\n");
  run(["add", "."]);
  // Commits exist only in disposable fixture repositories.
  run(["commit", "-q", "--no-gpg-sign", "-m", "Fixture base"]);
  run(["worktree", "add", "-q", "-b", "out/1", workspace]);
  const commitWork = (text = "result\n") => {
    writeFileSync(join(workspace, "tracked.txt"), text);
    run(["commit", "-q", "--no-gpg-sign", "-am", "Fixture result"], workspace);
    return run(["rev-parse", "HEAD"], workspace);
  };
  const check = (request: Partial<Omit<RetentionRequest, "repository" | "workspace">>) =>
    checkRetention(git, environment, { repository, workspace, outputBranch: "out/1", artefacts: [], ...request });
  return { dir, repository, workspace, run, commitWork, check };
}

test("committed work on the output branch in a clean workspace is retained", async () => {
  const f = fixture();
  const result = await f.check({ resultCommit: f.commitWork() });
  assert.deepEqual(result, { retained: true, findings: [], notes: [] });
});

test("a missing output branch or one without the result commit is not retained", async () => {
  const f = fixture();
  const commit = f.commitWork();
  assert.match((await f.check({ resultCommit: commit, outputBranch: "out/missing" })).findings.join(), /does not exist/);
  const base = f.run(["rev-parse", "main"]);
  // main exists but does not contain the result: branch existence alone is insufficient.
  const result = await f.check({ resultCommit: commit, outputBranch: "main" });
  assert.equal(result.retained, false);
  assert.match(result.findings.join(), /does not contain/);
  assert.notEqual(base, commit);
});

test("a definitively absent reported commit is a rejection, not a transient owner read", async () => {
  const f = fixture();
  f.commitWork();
  const result = await f.check({ resultCommit: "f".repeat(40) });
  assert.equal(result.retained, false);
  assert.match(result.findings.join(), /Result commit .* does not exist/);
  assert.equal(result.readFailures, undefined);
});

test("commits on no branch are not retained", async () => {
  const f = fixture();
  f.run(["checkout", "-q", "--detach"], f.workspace);
  const detached = f.commitWork("detached\n");
  const result = await f.check({});
  assert.equal(result.retained, false);
  assert.match(result.findings.join(), new RegExp(detached));
});

test("uncommitted and untracked files are not retained; ignored files are notes", async () => {
  const f = fixture();
  const commit = f.commitWork();
  writeFileSync(join(f.workspace, "tracked.txt"), "uncommitted\n");
  writeFileSync(join(f.workspace, "untracked.txt"), "new\n");
  mkdirSync(join(f.workspace, "cache"));
  writeFileSync(join(f.workspace, "cache", "build.bin"), "ignored\n");
  const result = await f.check({ resultCommit: commit });
  assert.equal(result.retained, false);
  assert.match(result.findings.join(), /2 uncommitted or untracked path\(s\).*M tracked\.txt.*\?\? untracked\.txt/);
  assert.match(result.notes.join(), /cache\//);
});

test("ignored files alone do not prevent retention", async () => {
  const f = fixture();
  const commit = f.commitWork();
  mkdirSync(join(f.workspace, "cache"));
  writeFileSync(join(f.workspace, "cache", "build.bin"), "ignored\n");
  const result = await f.check({ resultCommit: commit });
  assert.equal(result.retained, true);
  assert.equal(result.notes.length, 1);
});

test("required artefacts must exist outside the workspace", async () => {
  const f = fixture();
  const outside = join(f.dir, "report.md");
  writeFileSync(outside, "report\n");
  const inside = join(f.workspace, "cache", "report.md");
  mkdirSync(join(f.workspace, "cache"));
  writeFileSync(inside, "report\n");
  assert.equal((await f.check({ artefacts: [outside] })).retained, true);
  const result = await f.check({ artefacts: [join(f.dir, "missing.md"), inside, "relative.md"] });
  assert.equal(result.retained, false);
  assert.match(result.findings.join("\n"), /missing.*\n.*inside the workspace.*\n.*not absolute/);
});

test("dangling artefact links and unreadable non-file targets are not retained", async () => {
  const f = fixture();
  const dangling = join(f.dir, "dangling.md");
  symlinkSync(join(f.dir, "missing.md"), dangling);
  const directory = join(f.dir, "report-directory");
  mkdirSync(directory);
  for (const path of [dangling, directory]) {
    const result = await f.check({ artefacts: [path] });
    assert.equal(result.retained, false, path);
    assert.match(result.findings.join(), /artefact/i);
  }
});

test("an artefact link to an inaccessible target is not retained", { skip: process.platform === "win32" || process.getuid?.() === 0 }, async () => {
  const f = fixture();
  const target = join(f.dir, "private.md");
  const link = join(f.dir, "report-link.md");
  writeFileSync(target, "private report\n");
  symlinkSync(target, link);
  chmodSync(target, 0o000);
  try {
    const result = await f.check({ artefacts: [link] });
    assert.equal(result.retained, false);
    assert.match(result.findings.join(), /unreadable/);
  } finally { chmodSync(target, 0o600); }
});

for (const task of ["durable-real-adapter-p5a", "durable-report-p6", "durable-recovery-p7"]) {
  test(`${task}: the assigned artefact directory with log files is retained`, async () => {
    const f = fixture();
    const directory = join(f.dir, task, "artefacts");
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, "check.log"), "Checks passed\n");
    writeFileSync(join(directory, "tests.log"), "Tests passed\n");
    assert.deepEqual(await f.check({ artefacts: [directory], artefactDirectory: directory }), {
      retained: true, findings: [], notes: [],
    });
  });
}

test("nested artefact directories and internal links are retained", async () => {
  const f = fixture();
  const directory = join(f.dir, "artefacts");
  const nested = join(directory, "logs");
  mkdirSync(nested, { recursive: true });
  writeFileSync(join(nested, "tests.log"), "Passed\n");
  symlinkSync(join(nested, "tests.log"), join(nested, "linked.log"));
  symlinkSync(nested, join(directory, "linked-logs"), "junction");
  for (const path of [directory, nested, join(directory, "linked-logs")]) {
    assert.equal((await f.check({ artefacts: [path], artefactDirectory: directory })).retained, true);
  }
});

test("directories outside the assigned directory, or without an assignment, are refused with a reason", async () => {
  const f = fixture();
  const directory = join(f.dir, "artefacts");
  const outside = join(f.dir, "elsewhere");
  mkdirSync(directory);
  mkdirSync(outside);
  writeFileSync(join(outside, "tests.log"), "Passed\n");
  for (const artefactDirectory of [directory, undefined]) {
    const result = await f.check({ artefacts: [outside], ...(artefactDirectory ? { artefactDirectory } : {}) });
    assert.equal(result.retained, false);
    assert.match(result.findings.join(), /is a directory outside the assigned artefact directory/);
  }
});

test("empty directories, including directories containing only empty subdirectories, are refused", async () => {
  const f = fixture();
  const directory = join(f.dir, "artefacts");
  mkdirSync(directory);
  const check = () => f.check({ artefacts: [directory], artefactDirectory: directory });
  assert.match((await check()).findings.join(), /is an empty directory/);
  mkdirSync(join(directory, "empty"));
  assert.match((await check()).findings.join(), /no readable regular files/);
});

test("assigned directories in the workspace or a recyclable root are still refused", async () => {
  const f = fixture();
  const pool = join(f.dir, "pool");
  for (const directory of [join(f.workspace, "cache"), join(pool, "old-workspace", "artefacts")]) {
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, "tests.log"), "Passed\n");
    const result = await f.check({ artefacts: [directory], artefactDirectory: directory, recyclableRoots: [pool], scratchWorkspace: true });
    assert.equal(result.retained, false);
    assert.match(result.findings.join(), /inside the workspace|inside a recyclable workspace/);
  }
});

for (const linkKind of ["file", "directory", "dangling", "cycle"]) {
  test(`a directory with a ${linkKind} link that cannot be retained is refused`, async () => {
    const f = fixture();
    const directory = join(f.dir, "artefacts");
    mkdirSync(directory);
    writeFileSync(join(directory, "tests.log"), "Passed\n");
    const outside = join(f.dir, "outside");
    if (linkKind === "file") writeFileSync(outside, "Outside\n");
    if (linkKind === "directory") mkdirSync(outside);
    symlinkSync(linkKind === "cycle" ? directory : outside, join(directory, "link"),
      linkKind === "directory" || linkKind === "cycle" ? "junction" : "file");
    const result = await f.check({ artefacts: [directory], artefactDirectory: directory });
    assert.equal(result.retained, false);
    assert.match(result.findings.join(), /outside the assigned artefact directory|cannot be resolved|link cycle/);
  });
}

test("every file in a directory must be readable", { skip: process.platform === "win32" || process.getuid?.() === 0 }, async () => {
  const f = fixture();
  const directory = join(f.dir, "artefacts");
  mkdirSync(directory);
  writeFileSync(join(directory, "tests.log"), "Passed\n");
  const unreadable = join(directory, "private.log");
  writeFileSync(unreadable, "Private\n");
  chmodSync(unreadable, 0o000);
  try {
    const result = await f.check({ artefacts: [directory], artefactDirectory: directory });
    assert.equal(result.retained, false);
    assert.match(result.findings.join(), /is unreadable: .*private.log/);
  } finally { chmodSync(unreadable, 0o600); }
});

test("a check that cannot run counts as not retained", async () => {
  const f = fixture();
  const result = await checkRetention(git, { PATH: process.env.PATH ?? "" }, {
    repository: f.repository, workspace: join(f.dir, "no-such-workspace"), outputBranch: "out/1", artefacts: [],
  });
  assert.equal(result.retained, false);
  assert.match(result.findings.join(), /Could not check/);
});

test("a scratch workspace's leftovers are notes, while artefacts are still required", async () => {
  const f = fixture();
  writeFileSync(join(f.workspace, "scratch.txt"), "notes\n");
  const report = join(f.dir, "report.md");
  writeFileSync(report, "report\n");
  const kept = await f.check({ artefacts: [report], scratchWorkspace: true });
  assert.equal(kept.retained, true);
  assert.match(kept.notes.join(), /Scratch workspace: 1 uncommitted or untracked path/);
  assert.equal((await f.check({ artefacts: [join(f.dir, "missing.md")], scratchWorkspace: true })).retained, false);
});

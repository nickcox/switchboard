import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { checkRetention } from "../../src/workspaces/retention.ts";
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
  const check = (request: { resultCommit?: string; artefacts?: string[]; outputBranch?: string; scratchWorkspace?: boolean }) =>
    checkRetention(git, environment, { repository, workspace, outputBranch: request.outputBranch ?? "out/1", artefacts: request.artefacts ?? [], ...(request.resultCommit ? { resultCommit: request.resultCommit } : {}), ...(request.scratchWorkspace ? { scratchWorkspace: true } : {}) });
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

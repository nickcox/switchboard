import { expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { command, fixture, object, objects, text, treehouse } from "./helpers.ts";

async function repository(name: string, seeded = false) {
  const f = fixture(name);
  const repo = join(f.dir, "repository");
  mkdirSync(repo);
  await command(f, ["git", "init", "-b", "main", repo]);
  writeFileSync(join(repo, "tracked.txt"), "base\n");
  writeFileSync(join(repo, "treehouse.toml"), "max_trees = 1\n");
  if (seeded) {
    writeFileSync(join(repo, ".gitignore"), "seeded.txt\n");
    writeFileSync(join(repo, ".worktreeinclude"), "seeded.txt\n");
    writeFileSync(join(repo, "seeded.txt"), "fixture seed, not real credentials\n");
  }
  await command(f, ["git", "add", "."], { cwd: repo });
  // Commits exist only in disposable fixture repositories, never in Switchboard.
  await command(f, ["git", "-c", "core.hooksPath=/dev/null", "commit", "--no-gpg-sign", "-m", "Fixture base"], { cwd: repo });
  const base = (await command(f, ["git", "rev-parse", "HEAD"], { cwd: repo })).stdout.trim();
  const pool = join(f.dir, "pool-root");
  async function th(args: string[], allowFailure = false) {
    return command(f, [treehouse!, "--root", pool, ...args], { cwd: repo, allowFailure });
  }
  async function acquire(branch = "switchboard/fixture-a1/attempt-1") {
    const allocation = object(JSON.parse((await th(["get", "--lease", "--json", "--lease-holder", "fixture-a1", "--base", "main", "--branch", branch, "--no-fetch"])).stdout));
    return { id: text(allocation.lease_id), path: text(allocation.path), holder: text(allocation.lease_holder), branch };
  }
  async function status() {
    return objects(JSON.parse((await th(["status", "--json"])).stdout));
  }
  return { ...f, repo, base, th, acquire, status };
}

test("lease JSON and status preserve identity; conditional return and slot reuse retain the exact output commit", async () => {
  const f = await repository("treehouse-retention");
  const lease = await f.acquire();
  expect(lease.id).not.toBe("");
  expect(lease.holder).toBe("fixture-a1");
  expect((await command(f, ["git", "rev-parse", "HEAD"], { cwd: lease.path })).stdout.trim()).toBe(f.base);
  expect((await command(f, ["git", "branch", "--show-current"], { cwd: lease.path })).stdout.trim()).toBe(lease.branch);
  const listed = (await f.status()).find(row => row.lease_id === lease.id);
  expect(listed?.lease_holder).toBe("fixture-a1");
  expect(listed?.path).toBe(lease.path);
  writeFileSync(join(lease.path, "tracked.txt"), "worker result\n");
  await command(f, ["git", "add", "tracked.txt"], { cwd: lease.path });
  await command(f, ["git", "-c", "core.hooksPath=/dev/null", "commit", "--no-gpg-sign", "-m", "Fixture result"], { cwd: lease.path });
  const result = (await command(f, ["git", "rev-parse", "HEAD"], { cwd: lease.path })).stdout.trim();
  expect(result).not.toBe(f.base);
  // Both refs exist, but only the output branch retains this result commit.
  expect((await command(f, ["git", "merge-base", "--is-ancestor", result, "refs/heads/main"], { cwd: f.repo, allowFailure: true })).code).toBe(1);
  await command(f, ["git", "merge-base", "--is-ancestor", result, `refs/heads/${lease.branch}`], { cwd: f.repo });
  await f.th(["return", lease.path, "--if-lease-id", lease.id, "--if-lease-holder", lease.holder]);
  expect((await f.status()).find(row => row.path === lease.path)?.lease_id).toBe("");
  expect((await command(f, ["git", "rev-parse", `refs/heads/${lease.branch}`], { cwd: f.repo })).stdout.trim()).toBe(result);
  expect((await command(f, ["git", "rev-parse", "HEAD"], { cwd: lease.path })).stdout.trim()).toBe(f.base);
  const replacement = await f.acquire("switchboard/fixture-a1/attempt-2");
  expect(replacement.path).toBe(lease.path);
  expect(replacement.id).not.toBe(lease.id);
  expect((await f.th(["return", replacement.path, "--if-lease-id", lease.id], true)).code).not.toBe(0);
  expect((await f.status()).find(row => row.path === replacement.path)?.lease_id).toBe(replacement.id);
  expect((await command(f, ["git", "rev-parse", `refs/heads/${lease.branch}`], { cwd: f.repo })).stdout.trim()).toBe(result);
  await f.th(["return", replacement.path, "--if-lease-id", replacement.id]);
});

test("non-interactive dirty return refuses without force, and mismatched holder cannot touch changes", async () => {
  const f = await repository("treehouse-dirty");
  const lease = await f.acquire();
  writeFileSync(join(lease.path, "tracked.txt"), "uncommitted work\n");
  writeFileSync(join(lease.path, "untracked.txt"), "untracked work\n");
  expect((await f.th(["return", lease.path, "--if-lease-id", lease.id, "--if-lease-holder", "someone-else"], true)).code).not.toBe(0);
  expect((await f.th(["return", lease.path, "--if-lease-id", lease.id], true)).code).not.toBe(0);
  expect(readFileSync(join(lease.path, "tracked.txt"), "utf8")).toBe("uncommitted work\n");
  expect(existsSync(join(lease.path, "untracked.txt"))).toBe(true);
  expect((await f.status()).find(row => row.path === lease.path)?.lease_id).toBe(lease.id);
});

test("a clean Git tree does not retain seeded ignored evidence through return", async () => {
  const f = await repository("treehouse-seeded", true);
  const lease = await f.acquire();
  const seeded = join(lease.path, "seeded.txt");
  expect(existsSync(seeded)).toBe(true);
  writeFileSync(seeded, "Required evidence exists only here\n");
  expect((await command(f, ["git", "status", "--porcelain"], { cwd: lease.path })).stdout).toBe("");
  // Sacrificial fixture demonstrates why Switchboard must check artefacts separately.
  await f.th(["return", lease.path, "--if-lease-id", lease.id]);
  expect(existsSync(seeded)).toBe(false);
});

test("invalid base refuses acquisition rather than silently using main", async () => {
  const f = await repository("treehouse-base");
  expect((await f.th(["get", "--lease", "--json", "--lease-holder", "fixture-a1", "--base", "missing-base", "--branch", "output", "--no-fetch"], true)).code).not.toBe(0);
  expect(await f.status()).toEqual([]);
});

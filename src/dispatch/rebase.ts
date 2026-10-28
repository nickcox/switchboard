import type { AttemptFacts } from "./assess.ts";
import { checkCanRebase } from "./safety.ts";
import { branchHead, commitsBetween, isAncestor, workspaceState, type Git } from "../workspaces/integration.ts";

export type RebasedOutput = { commit: string; rebasedFrom: string; onto: string };
export type RebasePlan = { upstream: string; count: number };

/** Read every condition before a rebase, and again immediately before its intent. */
export async function planRebase(git: Git, facts: AttemptFacts, workspace: string, branch: string, original: string, upstream: string | undefined, moving?: RebasedOutput) {
  let head = await branchHead(git, branch);
  let state = await workspaceState(git, workspace);
  // A preceding planned move attaches this exact detached candidate before the rebase step rechecks its owners.
  if (moving?.commit === original && (head === moving.rebasedFrom || head === moving.commit) && state.branch === undefined && state.head === original && state.clean) {
    head = original;
    state = { ...state, branch };
  }
  const advanced = !!upstream && upstream !== original && await isAncestor(git, upstream, original);
  const commits = advanced ? await commitsBetween(git, upstream!, original) : { count: 0, merges: 0 };
  const permission = checkCanRebase(facts, { head, original, branch, workspaceBranch: state.branch, workspaceHead: state.head,
    clean: state.clean, upstream, advanced, merges: commits.merges });
  return { permission, upstream: upstream!, count: commits.count };
}

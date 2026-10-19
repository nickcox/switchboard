# Proving whole-worker termination on macOS

Status: input to the Phase 2 PRD, not a decision. Produced on 20 October 2026 by a Switchboard worker (Pi 1.2.0, `openai-codex` / `gpt-6.1-sol`) for backlog task `process-ownership-o1`, starting from commit `c90e09a`, and copied here unchanged apart from this note. Its claims about `launchd` process-group cleanup, the unsupported `kqueue` tracking flags and `es_new_descendants_client` (macOS 27, Endpoint Security entitlement, no root or TCC approval) were checked against the local manual pages and SDK headers when it was reviewed.

Task: `process-ownership-o1` · Deliverable: `report`

## Executive finding

A Pi exit, an empty process group, a missing launchd job, an empty current process tree, and a clean `lsof +D` scan are **not individually or jointly proof that every tool-started process stopped**. They leave escape paths through changed groups/sessions, reparenting, observation gaps, and work delegated to another service. Ordinary same-user macOS process management has no documented general-purpose Windows Job Object/cgroup-style containment-and-empty primitive identified in this survey.

For Phase 2, prototype a **per-attempt VM containment boundary**, not automatic return based on process scans. Until its stop and dispatcher-loss contract is qualified, retain the current `workerTermination: unverified` and preserve the lease. A native-only alternative worth investigating is Endpoint Security lineage tracking, but it adds entitlement/deployment requirements and must fail closed after event loss or monitor loss.

This is a design survey, not an implemented or qualified ownership mechanism. No repository changes, task mutations, lease operations, commits, or background-process experiments were made.

## Starting contract and meaning of proof

Read first: `docs/phases/01-basic-dispatch/runtime-integration.md`, especially “Unresolved process-ownership gate”, and `docs/adr/0005-pi-rpc-worker-and-result-file.md`, at starting commit `c90e09a71381b28b2596c51bf53a009b38ffdf26`.

Those documents explicitly distinguish model settlement, result validation, direct-child exit, whole-worker termination, and task acceptance. Phase 1 never returns workspaces; its child-exit receipt is not a whole-worker receipt. Runtime files under the same OS account are not an adversarial security boundary.

The runtime notes report source inspection of Pi coding-agent 1.2.0: Unix shell tools create detached process groups, track shell PIDs, and forget tracking when the shell finishes. A child left by a finished shell can survive Pi. They also report that Pi Durable 1.3.0 `NodeExecutionEnv` starts each command in a separate group and kills **tracked** groups on `cleanup()`, but removes a command from tracking when it completes. Cleanup therefore misses background descendants of finished commands. Switching to Durable does not close this gate. These are the repository's pinned-version findings, not fresh package-source verification in this survey.

The desired contract needs all of the following:

1. Membership established before any worker code runs and inherited across fork/exec, group changes, and session changes.
2. Admission closed before final termination: no restart, new dispatch, or external process injection into the attempt.
3. An authoritative empty/stopped observation, not just successful signal submission.
4. Stable attempt/container identity across dispatcher death; a PID alone is reusable.
5. Unknown observations preserve the lease and block redispatch.

Distinguish **direct descendants** from the broader causal phrase “every process the worker started”. `launchctl`, XPC, Docker APIs, SSH, schedulers, or a host command broker can ask an existing service to start work that is not a descendant. Even cgroups and Job Objects need a policy restricting such delegation. A guarantee covering remote services requires a separate remote-work lifecycle, not local process cleanup.

## Candidate mechanisms on macOS

### 1. POSIX process groups and sessions

Launch a worker in a new session/group; signal a group with `kill(-pgid, signal)`, allow a grace period, then escalate and observe exits.

- **Can prove:** exit of individually observed children; absence of signalable members in a particular group at an observation point, subject to permissions and API semantics. Useful bounded cleanup for cooperative tools.
- **Cannot prove:** descendant coverage. `setpgid()` moves eligible processes to another group; `setsid()` creates a new session/group when permitted. A group leader can fork a non-leader that creates a session. Tracking all initially known groups is still incomplete if finished commands have been forgotten. A session is not an unescapable container; there is no portable POSIX “kill this session and prove empty” operation.
- **Dispatcher loss:** processes/groups survive it; saved PGIDs and PIDs are not durable ownership capabilities and may be reused. `kill(..., 0)` is a permission/existence probe, not a lineage or shutdown proof. Group signal success does not mean every member has exited.
- **Privileges:** same-credential processes can ordinarily be signalled without root; cross-user control generally needs privilege. Root improves reach, not membership correctness.

**Verdict:** cleanup aid only, inadequate for current Pi even with non-malicious shell commands.

### 2. One launchd job per attempt

A unique job label can provide an OS-owned supervisor independent of the dispatcher. Use a foreground main program, no restart/demand triggers, bounded `ExitTimeOut`, and leave `AbandonProcessGroup` false.

- **Documented scope:** local `launchd.plist(5)` says: “When a job dies, launchd kills any remaining processes with the same process group ID as the job.” Setting `AbandonProcessGroup` true disables this behavior. This is a **same-PGID** guarantee, not a recursive-descendant guarantee.
- **Cannot prove:** termination of tools that chose another group/session. Pi's detached shell groups are already outside this documented cleanup scope. `bootout` removes a service/domain; that is not evidence that escaped descendants stopped. `launchctl kill` sends a signal to the service, not a proof of whole-worker termination. `EnableTransactions` and Pressured Exit track XPC activity/reclamation, not all descendants.
- **Dispatcher loss:** a job can remain managed and discoverable by its label, but its cleanup is not triggered merely because its client dispatcher died. A watchdog or explicit control protocol would be needed; escaped groups remain a gap. Disable automatic restart to preserve the single-launch contract.
- **Privileges:** own-user LaunchAgents generally require no root; system LaunchDaemons and switching user identity require administrator setup. TCC/privacy protections can still affect jobs. Do not parse `launchctl print` into an authoritative contract: its man page expressly says the output is not API.

**Verdict:** useful supervisor for a stronger boundary, not that boundary itself.

### 3. PPID process-tree scans (`ps`, `pgrep -P`, libproc)

- **Can prove:** observed parent relationships at sampled instants and exit of a child for which an actual wait/exit observation exists.
- **Cannot prove:** complete historical lineage. A short-lived shell can fork, exit, and leave an orphan reparented before the next scan. A remembered parent PID can be reused. Forking while a scan/kill loop runs creates races. Group/session changes alone do not break PPID, but parent death does. Environment tags and command-line markers are removable and are not ownership controls.
- **Dispatcher loss:** polling stops; subsequent PPIDs do not reconstruct lost ancestry. A launchd supervisor can keep a scanner alive but cannot make snapshots complete.
- **Privileges:** ordinary process metadata is often visible as a normal user; detailed inspection can be restricted. Cross-user signalling needs appropriate privilege; root does not recover missing history.

**Verdict:** diagnostics and best-effort cleanup, never the return authority.

### 4. Event-based tracking: kqueue, Endpoint Security, tracing

`kqueue(EVFILT_PROC)` is useful for exit notification of **known** processes. The local SDK documents fork notifications, but `sys/event.h` says `NOTE_TRACK`, `NOTE_TRACKERR`, and `NOTE_CHILD` have been unsupported since macOS 10.5. Do not import FreeBSD recursive-tracking assumptions. Notifications followed by a PPID scan do not eliminate discovery races; the SDK even notes that the child PID is not passed through in the actual `NOTE_FORK` kevent.

Endpoint Security (ES) is a materially stronger candidate: subscribe before launch to fork/exec/exit events, track stable audit-token process identities and lineage independently of PGID/SID, and retain membership after parent exit. Under a proven complete event stream, closed admission, and observed exits for every member, this could establish descendant termination.

- **Limits:** ES observes; it is not itself a kill-all container. Killing tracked PIDs requires identity-reuse protection and fork-race handling. Muting, event drops, initial subscription gaps, event ordering/draining, monitor crashes, and service-mediated launches must be addressed. `seq_num`/`global_seq_num` expose dropped events; any gap must invalidate the proof. A restarted monitor cannot simply infer all missing lineage from a current scan.
- **Dispatcher loss:** a separate monitor could survive it, but adds a persistent service and durable observation policy. Monitor loss must remain unknown rather than silently restarting into an empty inventory.
- **Privileges:** the established system-wide `es_new_client` path requires the Endpoint Security client entitlement, root, and Full Disk Access/TCC approval. This is not an entitlement-free Node library integration. kqueue visibility is narrower; DTrace/audit approaches have privilege, SIP, deployment, and loss concerns and are not a simpler supported containment API.
- **Important local-platform finding:** this host's macOS 27 SDK introduces `es_new_descendants_client` (availability macOS 27.0). Its header promises events for the caller's whole descendant subtree, including already existing descendants; it explicitly requires the ES entitlement but **not root or TCC approval**. This deserves a dedicated prototype, including orphan handling, rapid spawning, queue loss, and monitor death. It was not invoked here, and its availability and behavior must not be assumed on older supported macOS releases. It still does not promise kill-on-monitor-exit or capture work delegated outside the subtree.

**Verdict:** credible native research path, not presently qualified for automatic return.

### 5. Workspace open-file checks (`lsof +D`)

- **Can prove:** the tool reported particular visible open references to files/directories it found during the scan. A positive result is useful evidence to investigate, not proof that the process belongs to this attempt.
- **Cannot prove:** that no worker process exists. A process can close every workspace file, change cwd, retain just a pathname in memory, listen on a socket, or do unrelated work before reopening the workspace. Traversal and process inspection are not atomic. Unlinked objects, symlinks/mount traversal, and access limits complicate coverage. Even a hypothetically perfect instantaneous “no open files” answer would not prove future non-access or process exit.
- **Dispatcher loss:** a new scan works without historical state but cannot recover ownership or the lost interval.
- **Privileges:** run as the worker account for basic diagnostics; broader inspection may need root/privacy approvals. Root is not a temporal guarantee. `lsof(8)` explicitly documents traversal permission limits, default exclusions for symlink/mount crossings, and potentially expensive recursive traversal.

**Verdict:** optional negative safety check/diagnostic; never sufficient positive authority to return a lease.

### 6. Sandboxing, chroot, app coalitions, and account isolation

**App Sandbox / Seatbelt:** inherited restrictions can prevent filesystem, network, and IPC capabilities, helping block escape through service delegation. Local `sandbox(7)` explicitly says new processes inherit the sandbox, but already-open descriptors remain usable. `sandbox-exec(1)` is deprecated. App Sandbox needs signing/entitlement and an application packaging policy; running a basic restrictive profile does not require root. Neither facility supplies a public general-purpose “enumerate/kill all members and observe empty” handle. Detached descendants can remain alive within the same restrictions after dispatcher death. Denying `fork`/exec outright would impair ordinary compiler/test/shell workflows, and is not a drop-in Pi solution.

**chroot:** normally privileged, not process ownership or a security boundary against privileged code; does not terminate descendants or revoke already-open resources. launchd's own RootDirectory documentation warns about IPC/library assumptions.

**Coalitions, responsibility attribution, audit sessions:** macOS uses these for accounting/resource/lifecycle attribution. No suitable supported arbitrary-worker public kill-and-empty contract was established here. Do not base lease return on private coalition APIs, accounting IDs, or the presence of a job's audit session.

**Dedicated per-attempt UID:** fork/exec and PGID/SID changes ordinarily retain credentials. With root-controlled provisioning, no privilege escalation, no login/service entrypoints, and no external launch paths, a dedicated account makes surviving processes easier to find and kill after dispatcher loss. But UID scans plus repeated kills alone do not establish atomic quiescence under concurrent forks, and privilege/delegation escape defeats the boundary. It also changes workspace ownership, credential storage, Git access, and protection of runtime evidence. A shared worker UID cannot distinguish concurrent attempts safely.

**Verdict:** sandbox/account restrictions can strengthen an ownership design; none of these alone proves whole-worker shutdown.

### 7. Per-attempt VM (or container running inside a VM)

Run Pi and every tool inside one disposable guest. A guest process cannot leave that machine by calling `setsid`, double-forking, or surviving its guest supervisor. Stopping the VM stops execution of all its guest processes regardless of lineage.

- **Can prove, with a qualified implementation:** the identified guest is stopped, not merely that its Pi process exited. Local Virtualization framework headers document `stopWithCompletionHandler` as a destructive stop, with completion after stop or an error; state must also be checked. A graceful guest shutdown request alone is insufficient. Paused/saved guests are not terminated and must not be resumed after workspace reuse.
- **Cannot prove:** no remote jobs, external services, or host-side command-broker work. Restrict these capabilities. Host sharing helpers and pending I/O must be drained before workspace reuse: guest CPU stop is not by itself a filesystem flush/host-helper completion guarantee. A generic “container” on macOS is usually a Linux VM plus containers; it is the actual guest/container lifecycle contract, not the product name, that matters.
- **Dispatcher loss:** keep the VM owner separate from the dispatcher, or prove that loss of that owner destroys the guest. A missing PID or manager restart is not proof. Unknown owner state retains the lease. Prefer no restart, no saved-state restoration, and one VM identity per attempt.
- **Privileges:** Virtualization framework requires the virtualization entitlement and supported hardware/OS, normally without root for an entitled application. Image creation, macOS guest support/licensing, and shared-filesystem access add deployment constraints. A Linux guest changes toolchain semantics; native macOS tasks may require a macOS guest.

**Verdict:** strongest readily explainable macOS containment candidate, at meaningful implementation and resource cost; still needs dispatcher-loss and sharing qualification.

## Linux and Windows equivalents

These are design comparisons, not executed portability tests.

| macOS candidate | Linux equivalent and privileges | Windows equivalent and privileges |
| --- | --- | --- |
| Groups/sessions | POSIX groups/sessions; same-UID signals or suitable capability/root. Same detach and orphan limitations. | Console process groups/control events are not containment; service/session IDs are not Job Objects. Ordinary account rights suffice for own-process controls; access to other processes is restricted. |
| launchd job | systemd service/scope **with cgroup containment**, not just a tracked PID. User manager/delegation may avoid root; system-unit setup needs privilege. Configure whole-control-group stop and no restart. | Service Control Manager gives independent supervision but a service PID alone does not contain children. Installing a service normally needs administrator rights; use a Job Object for membership. |
| PPID inspection | `/proc`, `ps`, pidfds for known identities; proc permissions apply. A subreaper helps reap orphans but is not a kill-all boundary. | Toolhelp/WMI parent information and process handles; access rights apply. Snapshot/reuse/reparent-history problems remain; `taskkill /T` is not a durable ownership proof. |
| Event lineage | eBPF/tracepoints/audit/proc events; typically privileged or capability-controlled, with event-loss/recovery issues. Prefer cgroups to reconstructing lineage. | ETW process events typically need elevated tracing rights for full coverage; event loss and monitor recovery remain. Prefer Job Objects. |
| `lsof +D` | `lsof`/`fuser`, subject to UID/proc restrictions; same semantic insufficiency. | Handle inspection/Restart Manager/diagnostic tools, subject to process rights and elevation; no open handle does not imply process exit. |
| Sandbox/chroot/UID | namespaces, seccomp, LSMs, separate UID; privileged setup or configured user namespaces/delegation. PID namespace/container shutdown can help; not all namespaces imply termination. | AppContainer/restricted tokens and separate accounts limit capabilities but are not process-lifetime handles; setup privileges depend on method. |
| VM | KVM/QEMU or other VM, access to hypervisor devices or a privileged manager; same sharing/delegation caveats. | Hyper-V/other VM, feature setup and manager rights; same sharing/delegation caveats. |

### Strong native equivalents to target, not assumed macOS features

**Linux cgroup v2:** place the worker in a dedicated, manager-owned cgroup **before it executes**, allow inherited membership, deny worker migration out and access to outside launch brokers. Changing session/group does not change cgroup membership. Write `1` to `cgroup.kill`; kernel documentation explicitly covers concurrent forks and migration during killing. Then observe recursive `cgroup.events: populated 0`, with admission/restarts closed. The cgroup persists independently of the dispatcher, but is not automatically killed merely because the dispatcher exits; a manager stop policy or recovery action is needed. Root or correctly delegated cgroup access is required; do not delegate escape authority to the worker.

**Windows Job Objects:** create/configure a job with no breakaway permissions and `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`; create the worker suspended, assign it successfully, then resume it. Children created normally inherit membership even when detached from a console. Keep the job handle out of worker inheritance and prevent unintended duplication: kill-on-close acts only when the **last** handle closes. Use `TerminateJobObject` for explicit stop and query job accounting/active-process state to confirm empty with admission closed. Do not treat `WaitForSingleObject(job)` as a general empty-job test; Microsoft's documented job-signalling case concerns the end-of-job time limit. Completion-port notifications are not all guaranteed. Ordinary jobs for one's own child processes generally do not need administrator rights, but assignment/query/termination require appropriate object/process access and nested-job compatibility. WMI/service-mediated creation can occur outside the job; policy must disallow or separately own it. Dispatcher handle closure offers a strong crash cleanup path, but a later reader still needs reliable attempt-specific evidence, not “the old PID vanished”.

## Checks and bounded experiment

Host observed: macOS 27.0.1, build 26A434, Darwin arm64; normal user UID 501, not root. Local Xcode 27 SDK paths were resolved with `xcrun --show-sdk-path`. Read the launchd/sandbox manual sources and inspected SDK kqueue, Endpoint Security, and Virtualization declarations. No launchd job was installed; no sandbox, ES client, VM, cgroup, or Windows job was executed.

One safe experiment used foreground Python, `tempfile.TemporaryDirectory(prefix='switchboard-ownership-', dir='/tmp')`, and synchronous `subprocess.run` calls to:

```text
/usr/sbin/lsof -nP -a -p <Python PID> +D <temporary directory>
```

Python opened `probe.txt`, ran the scan, closed that file, then ran the same scan while the same Python process remained alive. PID 91971 appeared with FD `3w` for `/private/tmp/switchboard-ownership-xrsca_ld/probe.txt` on the first scan; the second scan had no matches. Both invocations returned status 1, despite the first having a matching row; neither printed stderr. Therefore this run's exit status must not be interpreted as an unqualified match/no-match contract. The decisive observation is simpler: the same live process disappeared from the workspace-reference output merely by closing its file. This is a minimal demonstration of the semantic gap, not a detached-process test or a general validation of lsof's platform behavior.

Both lsof children completed and were synchronously reaped. The temporary directory was removed by the context manager; the foreground Python command exited. No background processes were created. Final `git status --porcelain=v1`, `git diff --exit-code`, and `git diff --cached --exit-code` were clean.

## Sources and confidence

Directly consulted:

- Repository runtime notes and ADR-0005 cited above (including their pinned Pi/Durable findings).
- Local `/usr/share/man/man5/launchd.plist.5`: `AbandonProcessGroup`, `ExitTimeOut`, transaction/Pressured Exit keys, RootDirectory, privacy caveats.
- Local `/usr/share/man/man1/launchctl.1`: bootstrap/bootout, kill, diagnostic-output warnings.
- Local `/usr/share/man/man1/sandbox-exec.1`, `/usr/share/man/man7/sandbox.7`, and rendered `lsof(8)` manual.
- Under the SDK returned by `xcrun --show-sdk-path`: `usr/share/man/man2/kqueue.2`, `usr/include/sys/event.h`, `usr/include/EndpointSecurity/{ESClient,ESMessage,ESTypes}.h`, and `System/Library/Frameworks/Virtualization.framework/Headers/VZVirtualMachine.h`.
- [Linux cgroup v2 documentation](https://docs.kernel.org/admin-guide/cgroup-v2.html), retrieved successfully: populated notifications and `cgroup.kill` semantics.
- [Microsoft Job Objects](https://learn.microsoft.com/en-us/windows/win32/procthread/job-objects), retrieved successfully: child membership, breakaway, kill-on-close, service-mediated creation exception, notification and signalling caveats.

Relevant upstream API references for follow-up: [Endpoint Security](https://developer.apple.com/documentation/endpointsecurity), [Virtualization](https://developer.apple.com/documentation/virtualization), and the pinned [Pi Durable Node environment](https://unpkg.com/@earendil-works/pi-durable@1.3.0/dist/env/node.js) linked by the runtime notes. These follow-up URLs were not freshly retrieved here. Documentation supports the distinctions above; empirical crash/escape qualification remains future work.

## Recommended Phase 2 mechanism and open questions

**Recommend a per-attempt VM, owned outside the dispatcher, as the first mechanism to prototype for automatic workspace return on macOS.** Use groups/launchd for graceful control and diagnostics, not as the termination authority. If native-host execution is mandatory, keep automatic return disabled while prototyping ES descendant tracking plus capability restrictions; do not substitute scans for proof.

The proposed Phase 2 return barrier is: close admission and prohibit restart/resume → request graceful stop → force-stop the identified guest if needed → observe successful stopped state → drain/close attempt-owned sharing and I/O helpers → retain a separate whole-worker termination receipt → allow finalisation to consider workspace return. This receipt must be distinct from direct-child exit and from acceptance of the worker's report. Any missing, conflicting, inaccessible, or interrupted observation leaves the lease held and another dispatch blocked. Worker-writable filenames cannot provide adversarially trustworthy receipts.

Before adding a persistent VM owner/monitor service, explicitly revisit ADR-0003/0005 and compare Pi Durable's current execution environment. Durable may own later orchestration, but the 1.3.0 tracked-group cleanup described in the runtime notes does not replace the containment boundary. This recommendation does not authorize a service, replay, automatic restart, or a lease-policy change.

Open questions and required qualification:

1. **Supported execution environment:** must tools run on native macOS, or is a Linux guest acceptable? What macOS guest versions, licenses, signing/entitlements, startup cost, and resource budget are acceptable?
2. **Dispatcher/owner death:** test dispatcher SIGKILL, owner SIGKILL, stop timeout/error, host reboot, and loss of observation storage. Prove that a surviving VM is discoverable or that unknown blocks return; never infer shutdown from label/PID absence alone.
3. **Escape/delegation scope:** disable host command execution, Docker/launchd sockets, SSH/schedulers, and unsafe IPC unless each has an owned stop contract. Define whether remote jobs are prohibited or separately tracked.
4. **Workspace exposure:** compare copy-in/copy-out or a private guest disk against live host sharing. Prove helper shutdown, pending-write completion, artifact retention, and prevention of stale guest resume after reuse. Filesystem quiescence and process death are separate checks.
5. **Native alternative feasibility:** obtain the ES entitlement, determine the minimum supported macOS release, and exercise the macOS 27 descendant API's orphan, rapid-fork, muting, sequence-gap, and monitor-death behavior. Decide whether that deployment burden is preferable to a VM; do not assume the API solves crash cleanup.
6. **Escape/crash test matrix:** in an explicitly authorized future harness test ordinary children, Pi's detached groups, `setpgid`, `setsid`, double-fork, shells exiting before children, SIGTERM-resistant tools, rapid spawning, and dispatcher death. Verify no survivors and fail-closed behavior on injected uncertainty. No such background-process tests were run in this task.
7. **Portable infrastructure contract:** independently qualify Linux cgroup v2 and Windows Job Object implementations, including permission failures, worker launch before attachment, outside brokers, inherited handles, and fork/creation races. Export platform-neutral termination facts to dispatch policy, not Unix identifiers.

Until these are resolved and tested, the recommended operational behavior remains unchanged: report whole-worker termination as unverified and do not automatically return workspace leases.

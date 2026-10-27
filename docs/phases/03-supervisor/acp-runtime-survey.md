# ACP agents as Switchboard's second runtime

Status: input to the Phase 3 PRD, not a decision. Produced on 20 October 2026 by a Switchboard worker (Pi 1.2.0, `openai-codex` / `gpt-6.1-sol`) for backlog task `acp-adapters-a1` (attempt 2; attempt 1 failed when the provider connection dropped), and copied here unchanged apart from this note and dash style. Its claims about `_session/steering` in the Claude and Codex adapters, Claude's default `settingSources`, opencode's rejection of overlapping prompts and `pi-acp`'s turn queue were checked against the cited source commits when it was reviewed.

Research snapshot: 19 October 2026 (UTC). Deliverable: `report`.

## Conclusion

**Build one ACP transport/lifecycle adapter, initially qualify Claude Agent ACP.** Codex ACP is the next strongest candidate. OpenCode is viable but needs its own isolation profile; `pi-acp` is useful for interoperability testing, not a replacement for Switchboard's direct Pi runtime.

The architecture's caution remains correct for **portable ACP**, but needs qualification in future documentation: **Claude and Codex now implement active-turn steering through the non-standard `_session/steering` extension**. **`pi-acp` implements queued subsequent prompts**, not Pi's active-turn injection. No repository files were changed by this investigation.

None of these agents, merely by speaking ACP, guarantees all Switchboard requirements. Startup/configuration isolation and process-exit ownership still need agent-specific launch profiles and qualification tests.

## Scope and evidence

I first read the ACP paragraph under **Extension boundaries** in `docs/architecture.md`. I also inspected `src/runtime/contracts.ts`: the existing identity-checked JSON result contract can remain unchanged.

This is documentation/source research, **not authenticated end-to-end execution**. No agent was launched. Source findings below refer to inspected development heads, not an assertion that every registry release contains every feature. Registry metadata and the website already disagree about Claude's version, illustrating why releases must be pinned and capabilities negotiated.

Sources used:

- [ACP agents directory](https://agentclientprotocol.com/get-started/agents), [registry documentation](https://agentclientprotocol.com/get-started/registry), and [registry source](https://github.com/agentclientprotocol/registry/tree/a0e55d4f9e44f86584ca7050bf5489cbeed5c5f1). The registry is a curated distribution/authentication catalog, not a runtime-conformance certificate.
- Claude source head: [`7bcbfc7a5ca7ab9c7eece4f0749ccaf49c7ba7e1`](https://github.com/agentclientprotocol/claude-agent-acp/tree/7bcbfc7a5ca7ab9c7eece4f0749ccaf49c7ba7e1).
- Codex source head: [`a62b56847f473a2be6c67ea779c1ef9c7f227c38`](https://github.com/agentclientprotocol/codex-acp/tree/a62b56847f473a2be6c67ea779c1ef9c7f227c38).
- OpenCode source head (`dev`): [`d85746a054924241a7edde736eefd079dff9bc00`](https://github.com/anomalyco/opencode/tree/d85746a054924241a7edde736eefd079dff9bc00).
- Pi adapter source head: [`04d0a15d6bb42bb65cce5c9caedcdcb2cdcb6905`](https://github.com/svkozak/pi-acp/tree/04d0a15d6bb42bb65cce5c9caedcdcb2cdcb6905).

The wider catalog includes Gemini CLI, GitHub Copilot, Kimi, Qwen Code, Goose, Cline, Cursor, Mistral Vibe and others. This report's detailed shortlist is the four major implementations explicitly requested; it does not claim those are the only usable ACP agents.

## What ACP provides – and what it does not

| Switchboard need | ACP boundary |
|---|---|
| Separate process per attempt | Stdio supports launching a local process, but ACP also allows multiple sessions per connection. Switchboard must spawn a fresh server per attempt and forbid shared/reused servers. Some agents spawn another engine/server process. |
| Exact working directory | [`session/new`](https://agentclientprotocol.com/protocol/v1/session-setup) carries an absolute `cwd`. Also set the OS spawn cwd to the exact leased workspace; do not rely on a shell's inherited cwd. This is configuration, not a filesystem sandbox. |
| Pinned model | [Session config options](https://agentclientprotocol.com/protocol/v1/session-config-options) can expose a model selector; older implementations also expose the unstable model setter. A model option is not universally guaranteed. Set an exact provider/model ID before the first prompt, verify the returned selection, and reject unknown/fallback choices. |
| Disable operator extensions, skills, context files | **No portable ACP switch.** Requires a vetted launch environment and implementation-specific options. Empty `mcpServers` does not disable locally configured MCP servers, plugins, skills, or instruction discovery. |
| Structured worker result | `session/prompt` does not impose Switchboard's JSON schema. Ask the worker to write the supplied absolute result-file path using its file/shell tools; grant that path explicitly and validate it independently. `end_turn` is not a successful Switchboard result. |
| Cancellation and observable exit | [`session/cancel`](https://agentclientprotocol.com/protocol/v1/prompt-turn#cancellation) cancels work, not the server process. Switchboard must separately shut down/terminate the process and observe child exit. A cancelled response, EOF, or an idle session is not proof that descendants stopped. |
| Usage | `usage_update` conveys context occupancy/window and optional cumulative monetary cost. It is not the sum of billed input/output tokens. The [end-turn token-usage RFD](https://agentclientprotocol.com/rfds/end-turn-token-usage) explicitly remains Draft; implementation token fields/extensions must be version-qualified. |
| Follow-up and steering | Another prompt after the previous turn ends is normal conversation. In-flight injection and overlapping-prompt queues are not a portable ACP v1 contract. See the concrete exceptions below. |

ACP can delegate filesystem or terminal operations to the client when negotiated, but that is not required for every agent: `pi-acp`, for example, runs its tools locally. Permission requests therefore need a noninteractive, fail-closed Switchboard policy, not an assumption that an editor/user will answer.

## Agent comparison

### 1. Claude Agent ACP  –  strongest first integration

**Start:** install a pinned `@agentclientprotocol/claude-agent-acp` and execute `claude-agent-acp` over stdio (development convenience: `npx -y @agentclientprotocol/claude-agent-acp@0.94.0`). The [registry entry](https://github.com/agentclientprotocol/registry/blob/a0e55d4f9e44f86584ca7050bf5489cbeed5c5f1/claude-acp/agent.json) selects 0.94.0; the fetched website still displayed 0.93.0. Production should resolve/install beforehand and launch the concrete executable, not download `latest` during dispatch. This is an adapter using Anthropic's Agent SDK/Claude Code engine, not native `claude --acp`.

**Requirements:**

- Launch a private adapter process and create exactly one new session per attempt. The SDK engine is an additional process to supervise.
- The adapter forces SDK `cwd: params.cwd`; model selection is exposed through session configuration. Pin the SDK/engine as well as the adapter and select an exact model rather than an alias such as “default”.
- **Isolation is available through a private extension, not the default.** The adapter defaults to `settingSources: ["user", "project", "local"]`. Its `_meta.claudeCode.options` SDK-options pass-through can override this with `settingSources: []`; `plugins` is also an allowed option. A Switchboard profile should explicitly set empty setting sources/plugins, use a clean private configuration/home environment, supply only approved credentials, and avoid inherited custom hooks, extra arguments and fallback models. This gives a concrete isolation mechanism to qualify; it is not evidence that all ambient memory/skills/admin-policy paths have been eliminated in a real installation. Test those paths before enabling dispatch.
- Write/Edit/Bash tools can produce the JSON result file. Its retained location may be outside cwd, so permissions must allow precisely that destination rather than blanket access. File existence/schema/identity remain Switchboard checks.
- `session/cancel` interrupts the turn, **not process exit**. The README specifically notes background commands can survive cancellation; parent cancellation can also spare background subagents. Termination and descendant ownership need separate handling.

**Usage:** the adapter maps SDK result usage into prompt response `usage` and `_meta.quota.token_count` / `_meta.quota.model_usage`. The main-loop token count and per-model totals have different scopes: per-model rows can include subagents, sidechains and compaction, so **do not add them together**. `usage_update` carries latest context usage, context-window size, and SDK cumulative `total_cost_usd` as USD. Preserve source/scope and unknown values; these are not all interchangeable “usage”.

**Messages:** the inspected v1 implementation supports both queued `session/prompt` turns and `_session/steering`. It advertises `_meta.steering.supported` at initialization. Steering returns `injected`, or by default `startedNewTurn` if the active turn has already ended. The newer opt-in `_meta.steering.idleBehavior: "promptRequired"` instead leaves the idle fallback to the host. Use that option where supported to avoid silently starting unowned work. Injection normally uses SDK priority `now`, but uses `later` while waiting for permission/elicitation; steering can abort generation or background a foreground tool. It is **not** a promise to stop every old operation before following the new instruction.

Sources: [README, including experimental-v2 and cancellation caveats](https://github.com/agentclientprotocol/claude-agent-acp/blob/7bcbfc7a5ca7ab9c7eece4f0749ccaf49c7ba7e1/README.md); [`acp-agent.ts` allowed options/defaults, `steer()`, usage handling and `turnQuotaMeta()`](https://github.com/agentclientprotocol/claude-agent-acp/blob/7bcbfc7a5ca7ab9c7eece4f0749ccaf49c7ba7e1/src/acp-agent.ts#L4285); [extension negotiation](https://github.com/agentclientprotocol/claude-agent-acp/blob/7bcbfc7a5ca7ab9c7eece4f0749ccaf49c7ba7e1/docs/air-extensions.md).

### 2. Codex ACP  –  strong alternative, especially for native steering

**Start:** pinned `@agentclientprotocol/codex-acp`, executable `codex-acp` (or `npx -y @agentclientprotocol/codex-acp@2.2.2` for evaluation). The package includes a compatible Codex dependency and starts **Codex App Server**. `CODEX_PATH` selects a specific engine binary. The [registry](https://github.com/agentclientprotocol/registry/blob/a0e55d4f9e44f86584ca7050bf5489cbeed5c5f1/codex-acp/agent.json) lists stable 2.2.2 and a separate preview channel. Do not infer that a development-head feature is in stable just because package.json still says 2.2.2.

**Requirements:**

- Fresh adapter + app-server per attempt; ACP session cwd maps to the Codex thread. Select exact model/config before prompting. Approval and sandbox modes are configurable; they are separate from model/config isolation.
- `CODEX_CONFIG` accepts JSON merged into session configuration; `MODEL_PROVIDER` selects the provider. These are overrides, **not a documented “ignore everything” switch**.
- A private `CODEX_HOME`, clean HOME/XDG locations and an allowlisted environment remove ordinary user configuration/credential discovery, with credentials deliberately reintroduced. They do **not** establish that repository `.codex` configuration, ancestor `AGENTS.md`, skills, hooks, plugins or managed policy cannot load. A fully hermetic recipe needs validation against the pinned Codex engine; this investigation does not certify one. That is the principal readiness gap relative to Claude's explicit setting-source override.
- File/shell tools can write the JSON result when sandbox/permission policy allows the retained path. Cancellation maps to turn interruption; process shutdown and observed exits of adapter/engine are still host responsibilities. The app-server can maintain background terminal tasks, so prompt completion/cancellation alone is insufficient.

**Usage:** `thread/tokenUsage/updated` supplies latest and cumulative token counts plus model context window. `CodexEventHandler` emits `usage_update` using **latest request totalTokens as a context proxy**, not cumulative billed consumption. The server tracks prompt consumption separately and returns `usage` plus `_meta.quota` token/model rows; resumed history can make the starting baseline unknown. The source explicitly says model attribution currently assigns all tokens to the current model. No monetary `cost` appears in the inspected `createUsageUpdate`; do not fabricate dollar totals for subscription use.

**Messages:** `_meta.steering.supported` advertises the same non-standard `_session/steering` method. It calls native app-server `turn/steer` using thread and active-turn IDs. Replies include `injected`, `startedNewTurn`, or `failed`; if the turn ended, the adapter can start a new turn. The inspected Codex extension type does **not** offer Claude's `promptRequired` idle option. Concurrent steering requests are serialized per session. The experimental v2 prompt implementation also queues overlapping prompts; that is implementation behavior, not a universal ACP rule or a reason to bypass host message ownership.

Sources: [README/options](https://github.com/agentclientprotocol/codex-acp/blob/a62b56847f473a2be6c67ea779c1ef9c7f227c38/README.md); [`AcpExtensions.ts` wire types](https://github.com/agentclientprotocol/codex-acp/blob/a62b56847f473a2be6c67ea779c1ef9c7f227c38/src/AcpExtensions.ts#L122); [`CodexAcpServer.ts` steering, queues and prompt accounting](https://github.com/agentclientprotocol/codex-acp/blob/a62b56847f473a2be6c67ea779c1ef9c7f227c38/src/CodexAcpServer.ts#L2594); [`CodexAcpClient.ts` native steer call](https://github.com/agentclientprotocol/codex-acp/blob/a62b56847f473a2be6c67ea779c1ef9c7f227c38/src/CodexAcpClient.ts#L1361); [`CodexEventHandler.ts` context usage](https://github.com/agentclientprotocol/codex-acp/blob/a62b56847f473a2be6c67ea779c1ef9c7f227c38/src/CodexEventHandler.ts#L1243).

### 3. OpenCode  –  native ACP command, but no active-prompt injection through inspected ACP surface

**Start:** `opencode acp`. The [registry entry](https://github.com/agentclientprotocol/registry/blob/a0e55d4f9e44f86584ca7050bf5489cbeed5c5f1/opencode/agent.json) distributes platform-specific 1.19.3 binaries with the `acp` argument. Inspected development source starts a private standalone backend behind the stdio ACP frontend; it is not necessarily a single OS process.

**Requirements:**

- Run a private frontend/backend per attempt, create a new ACP session with exact cwd, select an exact provider/model through the advertised model configuration, and record both process and session identities.
- Its own options include `OPENCODE_CONFIG`, `OPENCODE_CONFIG_CONTENT`, `OPENCODE_CONFIG_DIR`, project-config disable controls (`OPENCODE_CONFIG_PROJECT_DISABLE`, with legacy `OPENCODE_DISABLE_PROJECT_CONFIG`), and Claude compatibility/skill-discovery disable controls. These are implementation-specific, not ACP features. A custom config directory is not automatically proof that every user resource source is disabled.
- Use private home/XDG/config/data directories and controlled explicit configuration, disable unwanted project/Claude discovery, and qualify instruction, skill, plugin and managed-configuration discovery independently. The inspected instruction plugin separately discovers global and project `AGENTS.md` and loads explicit `instructions` entries even when discovery is off. Therefore “disable project config” alone is **not** a full no-context-files recipe. Full isolation remains unverified here.
- Editing/shell capabilities can write the result file subject to tool permissions; map the retained output path explicitly. ACP cancellation interrupts work; the frontend also monitors connection/backend exit. Still require observed process exit rather than treating a cancelled prompt as worker termination.

**Usage:** at settlement the ACP turn code emits `usage_update` with the latest model request's total tokens, selected model context limit, and cumulative session `info.cost` in USD. It skips the update when usage/context limit is unavailable. This is useful context/cost telemetry, not a complete portable input/output/cache-token billing breakdown.

**Messages:** the inspected ACP `prompt` handler rejects overlapping prompts with **“Session already has an active ACP prompt”**. It does not expose `_session/steering`. Although its backend submission uses `delivery: "steer"`, the ACP concurrency guard prevents using a second ACP prompt to inject into the active ACP turn. Do not infer ACP steering from an internal field name. Normal subsequent prompts work after the current one finishes; Switchboard could own a follow-up queue.

Sources: [`commands/handlers/acp.ts` frontend/backend lifecycle](https://github.com/anomalyco/opencode/blob/d85746a054924241a7edde736eefd079dff9bc00/packages/cli/src/commands/handlers/acp.ts); [`acp/turn.ts` submission, usage, concurrency guard and cancellation](https://github.com/anomalyco/opencode/blob/d85746a054924241a7edde736eefd079dff9bc00/packages/cli/src/acp/turn.ts#L370); [`server-process.ts` environment controls](https://github.com/anomalyco/opencode/blob/d85746a054924241a7edde736eefd079dff9bc00/packages/cli/src/server-process.ts); [`config/plugin/instruction.ts` discovery](https://github.com/anomalyco/opencode/blob/d85746a054924241a7edde736eefd079dff9bc00/packages/core/src/config/plugin/instruction.ts).

### 4. `pi-acp`  –  adapter-side queue, not Pi RPC parity

**Start:** pinned `pi-acp` (registry: 0.0.34; evaluation: `npx -y pi-acp@0.0.34`). Requires separately installed Pi, currently documented as v0.81.0+. It launches `pi --mode rpc --no-themes`; it is not built-in ACP support in Pi. Pin both components.

**Requirements:**

- One private adapter process plus one Pi child for the new session; spawn passes `cwd: params.cwd`. Model config supports provider/model selection and the older unstable model method.
- **Not isolated by default:** source deliberately retains extensions and templates, and README advertises direct skill loading. Child arguments are fixed apart from session-file selection; arbitrary Pi startup flags are not exposed by normal ACP session setup.
- `PI_ACP_PI_COMMAND` selects a custom executable and the Pi child inherits the adapter environment. A Switchboard-owned executable wrapper could `exec` pinned Pi with `--no-extensions --no-skills --no-prompt-templates --no-context-files` plus private config/session settings. This is an extra launch integration, not capability of generic ACP. Pi's own CLI documents these flags, but the adapter also discovers file-based prompt commands itself; disabling Pi's discovery alone does not necessarily disable adapter-side discovery. Review both layers before claiming isolation.
- Pi locally executes its filesystem/shell tools; `pi-acp` explicitly does not implement ACP filesystem/terminal delegation. It can write the result file, but client-side ACP file-permission handlers cannot alone constrain those local writes.
- Cancel calls Pi RPC abort and clears queued prompts. The child wrapper observes Pi exit internally and can signal it on disposal, but ACP still does not deliver a Switchboard-owned engine exit record. Supervise adapter + Pi, not just the cancelled prompt.

**Usage:** `get_session_stats.contextUsage` becomes `usage_update {used, size}` after turns and on session/model transitions. It may be absent with older Pi or temporarily unavailable after compaction. This is **context occupancy**, not all billed tokens or cost. `/session` prints stats including tokens/cost, but human-readable command output is not a dependable machine-accounting API. The inspected automatic mapping sends no `cost` or complete token breakdown.

**Messages:** `Session.prompt()` puts overlapping prompts into an adapter `turnQueue`, starts each after the current turn finishes, and reports best-effort text plus `_meta.piAcp.queueDepth`. Cancel clears the queue. This supports queued follow-up behavior, but **does not call Pi's `steer` RPC to alter an active turn**. `/steering` and `/follow-up` adjust Pi delivery modes; they do not themselves expose a message-injection operation. Thus the architecture note overstates the loss of follow-up *queueing* today, while its warning about losing active-turn steering remains accurate for this adapter.

Sources: [README/limitations](https://github.com/svkozak/pi-acp/blob/04d0a15d6bb42bb65cce5c9caedcdcb2cdcb6905/README.md); [`pi-rpc/process.ts` launch and disposal](https://github.com/svkozak/pi-acp/blob/04d0a15d6bb42bb65cce5c9caedcdcb2cdcb6905/src/pi-rpc/process.ts#L154); [`acp/session.ts` queue/cancel/context usage](https://github.com/svkozak/pi-acp/blob/04d0a15d6bb42bb65cce5c9caedcdcb2cdcb6905/src/acp/session.ts#L367); [`acp/agent.ts` configuration and slash commands](https://github.com/svkozak/pi-acp/blob/04d0a15d6bb42bb65cce5c9caedcdcb2cdcb6905/src/acp/agent.ts); [Pi CLI resource flags](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/cli.md#resources).

## Does ACP itself support steering or queued messages?

**ACP v1:** the [prompt-turn specification](https://agentclientprotocol.com/protocol/v1/prompt-turn) defines a request lasting through the turn and returning a stop reason. It defines cancellation but not a standardized active-turn injection method or queue lifecycle. Another prompt after completion is supported conversation; sending it during an active turn is implementation-specific.

**ACP v2:** the [prompt lifecycle](https://agentclientprotocol.com/protocol/v2/prompt-lifecycle) separates insertion from completion: a successful prompt response returns `messageId` once the message is inserted, while session `state_update` reports running/requires_action/idle. That response does not prove model consumption or durable storage. The [v2 prompt RFD](https://agentclientprotocol.com/rfds/v2/prompt) explicitly says: **“This RFD does not specify queueing, steering, or whether agents insert new prompts while busy.”** This is a better foundation, not a portable steer/queue guarantee. Claude's README labels v2 experimental and says its steering extension is currently v1-only.

**Actual supported exceptions:**

| Inspected agent surface | Active-turn steering | Overlapping/queued prompts |
|---|---|---|
| Claude ACP v1 | Yes, negotiated private `_session/steering`; may pre-empt/background work | Adapter queues ordinary prompt turns |
| Codex ACP | Yes, negotiated private `_session/steering` → native `turn/steer`; idle race may start new turn | Explicit queue in inspected experimental-v2 path; do not assume portable v1 behavior |
| OpenCode ACP | No exposed injection method in inspected source | Rejects active-prompt overlap |
| `pi-acp` | No active injection exposed | Adapter queue; sequential next turns; cancel clears it |

A queue acknowledgment is not proof of delivery, and an `injected` response is not proof the model acted on the new instruction. Switchboard must keep message ownership, authorization and delivery observations separate.

## Recommendation and runtime-interface changes

**Support Claude Agent ACP first, using a pinned ACP v1 profile and making isolation qualification a release gate.** It combines explicit setting-source overrides, model control, useful cost/token telemetry, ordinary follow-ups, and optional active steering. Codex ACP should follow once a pinned-engine hermetic configuration recipe is verified. Do not replace direct Pi RPC with `pi-acp`: that adds a translation process while losing controls Switchboard already has.

The generic runtime interface should change in these specific ways:

1. **Capabilities, not Pi assumptions.** Expose normal subsequent prompts, host-queued follow-ups, agent-managed queues, active-turn steering, cancellation, and usage availability independently. Generic ACP can support a host queue without promising steering. Unsupported `steer` must refuse explicitly; never silently convert it to cancel-and-reprompt or a new attempt.
2. **Separate stable attempt identity from opaque engine identity.** Keep the existing Switchboard context/task/lease/session identity and JSON schema. Persist a mapping to ACP session ID and engine session/thread ID; ACP-generated strings need not be UUIDs or caller-selected. Store launch/version/profile metadata for recovery and reject stale-session output.
3. **Specify launch and isolation as runtime responsibilities.** Define executable/argv, exact cwd, allowlisted environment, pinned adapter/engine/model, private configuration/session paths, and validated permission policy. Keep agent-specific options and `_meta` formats inside profiles, not dispatch policy. Do not reuse global daemons or recovered sessions for fresh attempts.
4. **Separate turn end, worker result and worker exit.** Preserve result-file validation plus observed direct-child exit. Model `cancelTurn` and `terminateAttempt` separately; implement shutdown deadlines, escalation and exit observations. Retain the architecture's whole-worker ownership gate – ACP does not solve orphaned descendants or authorize workspace recycling.
5. **Normalize usage without inventing precision.** Represent context occupancy, cumulative cost, per-prompt input/output/cache/reasoning tokens, and provider/model attribution as optional separately scoped observations. Preserve raw agent telemetry. Deduplicate cumulative updates; do not sum context snapshots, treat missing values as zero, or double-count main-loop and per-model rows.
6. **Make message delivery explicit and race-aware.** Record requested mode, authorization, accepted/queued/injected/started-new-turn/failed/unknown states and target attempt/session. Keep operator approval for changing an active worker's instructions. Negotiate `_meta.steering.supported`; version-gate extensions. Claude's host-owned idle fallback is preferable; where absent, report the new-turn race honestly and do not retry an uncertain injection automatically.
7. **Gate support with focused conformance tests.** Before real dispatch, test exact cwd/model, hostile user/project extensions/skills/context files, outside-cwd result permissions, malformed/missing/stale result identity, cancel during tools, actual engine/adapter exit, usage scope, and steering-at-turn-end races. The research establishes implementation routes, not a completed safety certification.

The first milestone should therefore be **one safely isolated Claude attempt producing the existing validated result file and an observed process exit**. Add optional steering only after that lifecycle works; retain direct Pi as the fully controlled first runtime.

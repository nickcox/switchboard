# Worker provider failures: Pi 1.2.0 investigation

> **Cause found after this report was written: the computer went to sleep.** Each failure followed macOS idle sleep on battery while the worker was mid-response. Claude Code, which ran the dispatches, holds a `caffeinate` assertion only during its own turns, not while waiting for a background command. The power log (`pmset -g log`, times AEDT):
>
> | Attempt | Idle sleep | Woke | Error recorded |
> | --- | --- | --- | --- |
> | `acp-adapters-a1` | 20 Oct 08:41:23 | 08:42:43, keyboard | 08:43:15, `WebSocket error` |
> | `phase2-review-r1` | 21 Oct 08:29:05 | 08:31:59, keyboard | 08:33:05, `WebSocket error` |
> | `db-runtime-d3` | 22 Oct 09:22:25 | 09:23:49, keyboard | 09:24:59, `WebSocket error` |
> | `observe-assess-o1` | 22 Oct 12:28:16 | 12:37:56, maintenance wake | 12:37:56, idle timeout |
> | `provider-errors-s1` (this report's own attempt) | 22 Oct 14:08:13 | 14:17:53, maintenance wake | 14:17:53, idle timeout |
>
> When the operator woke the computer, the provider had already closed the connection and Pi reported `WebSocket error` within about a minute. When it slept until a maintenance wake, Pi's 300-second idle timer, paused during sleep, expired in the same second as the wake. So the report's finding of no common pattern is wrong, and its recommendation to enable Pi's automatic retry no longer follows: a retry cannot run while the computer sleeps. Its analysis of what Pi's retry does remains accurate and was checked against the retained Pi 1.2.0 source (`_startRun` sends the prompt once and retries with `agent.continue()`; the agent loop does not run tools from a response that ended in an error). The fix is for the dispatcher to keep the computer awake while a worker runs (backlog task `keep-awake-k1`).
>
> **How this report was recovered.** The attempt was itself cut off by sleep while streaming this report as one `write` call, so the file was never written. The text below is that partial call, recovered from the attempt's session transcript, unchanged apart from em-dashes replaced with en-dashes; it ends partway through section 3. The evidence files it mentions (`transcript-metrics.json`, `collect-evidence.py`, `pi-source/`, `pi-docs/`, `source-manifest.json`, `check-provider.mjs`, `provider-check.txt`) are in the attempt's artefact directory on the operator's machine, `~/.switchboard/switchboard/runtime/487537935c922e003caf22a9e8b0108e8b13ff4b350a2a2e83e290c48314cd3c/a352be188bfc78d10c6abfbfd839c69fa106652e062a24b202181b4452e80595/artefacts/`, not in the repository.

Task: `provider-errors-s1`, attempt 1. Investigated 22 October 2026 (AEDT). **Report only; no Switchboard code, configuration, task records, leases, or evidence transcripts changed.**

## Conclusion and recommendation

These are **provider response-stream failures, not evidence of lost RPC prompt acknowledgements**. All four failing requests had received provider events and a response ID. Pi deliberately surfaces a transport failure after streaming starts rather than immediately replaying it over SSE.

**Pi's bounded agent-level automatic retry is compatible with ADR-0005's specific lost-acknowledgement rule:** it does not resend an RPC `prompt`, append the operator's user message again, launch another worker, or create another Switchboard attempt/session. It continues the existing conversation at the failed assistant turn. It **does** make another provider generation request and start another *low-level agent run*. It cannot promise exactly-once generation or charging at the provider. Those are different guarantees; ordinary tool turns already send existing conversation context to the provider repeatedly.

Recommend a separately authorized, reviewed change to permit Pi's bounded agent-level retry inside a live worker, while retaining Switchboard's prohibition on RPC message replay and same-session relaunch. ADR-0005 explicitly requires reconsideration before adding retries, and `docs/architecture.md:134` currently selects new attempts instead; update that policy explicitly before implementation, not silently. This report makes no such change. Keep the present behavior until that decision is authorized.

For the observed failures this is a plausible within-attempt recovery path: both error strings are retryable, and Pi marks a failed WebSocket session for **SSE on its next provider call**. A deterministic, offline provider-function check confirms this behavior. This is not proof that the real provider would have recovered: outage duration, remaining attempt time/cost, and SSE health are unknown.

Prefer the existing agent retry defaults (three retries, 2/4/8-second delays), `retry.provider.maxRetries: 0`, and existing attempt time/cost limits. An authorized transport experiment with `transport: "sse"` is also prompt-deduplication-safe and avoids this WebSocket path, but does not itself recover a failed SSE stream. For genuinely long silent reasoning, consider a bounded higher `httpIdleTimeoutMs` (for example 600000), checking for a `retry.provider.timeoutMs` override. Do not disable all deadlines or claim that a larger idle limit fixes socket closures. If policy instead means “no repeated provider generation at all,” do **not** enable retry: retain explicit new attempts after confirmed worker exit, as the Phase 4 note proposes. That stricter interpretation is not what the ADR's lost-RPC-ack rationale establishes.

## Evidence and method

Read-only discovery command from the assigned workspace:

```sh
node src/cli.ts status --json \
  --config /Users/nick/.switchboard/switchboard/switchboard.json
```

(`switchboard` is not on this worker's PATH, so the repository CLI was used.) Selected attempt 1 of each named task and read its `transcript` path as bytes/JSONL, **not through Pi's session loader**, which can migrate old formats. All four files are linear parent chains with exactly one system and one user message, no compaction, context edits, branching, or later continuation. Hash, byte length, and modification time were checked unchanged after reading; final verification rechecks the retained hashes.

Retained evidence alongside this report:

- `transcript-metrics.json`: exact original transcript paths, SHA-256 hashes, entry IDs/line numbers, timestamps, diagnostics/stacks, message counts, and usage. No full prompts, tool outputs, or encrypted reasoning are copied into the report.
- `collect-evidence.py`: reproducible read-only analysis and installed-source extraction. Run `python3 collect-evidence.py STATUS_JSON OUTPUT_DIRECTORY` with the status JSON from the command above.
- `pi-source/`: original TypeScript **`sourcesContent` extracted from installed 1.2.0 source maps**, not current upstream `main`. Coding agent, pi-ai, and pi-agent-core package versions were each verified as 1.2.0.
- `pi-docs/`: installed documentation used here; `source-manifest.json` records installed paths, source-map hashes, retained source names and hashes. No upstream commit identity is asserted.
- `check-provider.mjs` and `provider-check.txt`: deterministic checks against installed pi-ai 1.2.0 functions, with fake WebSockets/fetch, synthetic credentials, and no network calls or other agent/worker launches.

**Citation convention:** `CA` = `packages/coding-agent/src`, `AI` = `packages/ai/src`, `AG` = `packages/agent/src`. These correspond respectively to retained `pi-source/coding-agent/src`, `pi-source/ai/src`, and `pi-source/agent/src`. All source citations below refer to original TypeScript line numbers in those retained files. Installed root: `/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent`; AI/AG packages are under its `node_modules/@earendil-works/`. Switchboard citations refer to starting commit `acf2fc9a29e217fa6281a91832b752cf760f793f`.

## 1. What happened in each attempt

### Timing

“Session elapsed” is header creation to persisted final error, not worker process lifetime. Request start is nested assistant `message.timestamp`, initialized when the provider stream function builds its output (`AI/api/openai-codex-responses.ts:239–263`). Request duration is recorded monotonic `durationMs` (`AI/utils/event-stream.ts:91–130`). The outer entry timestamp is persistence at failure; wall and monotonic intervals differ by milliseconds.

| Task, attempt 1 | Session created (UTC) | Failing request started (UTC) | Error persisted (UTC) | Session elapsed / failing request duration |
|---|---|---|---|---|
| `acp-adapters-a1` | Oct 19 21:38:17.749 | Oct 19 21:40:43.792 | Oct 19 21:43:15.109 | **4m57.360s / 2m31.317s** |
| `phase2-review-r1` | Oct 20 21:26:20.605 | Oct 20 21:29:00.004 | Oct 20 21:33:05.714 | **6m45.109s / 4m05.707s** |
| `db-runtime-d3` | Oct 21 22:03:04.038 | Oct 21 22:22:19.782 | Oct 21 22:24:59.537 | **21m55.499s / 2m39.751s** |
| `observe-assess-o1` | Oct 22 01:04:32.841 | Oct 22 01:27:48.184 | Oct 22 01:37:56.536 | **33m23.695s / 10m08.349s** |

Local failure times (AEDT, UTC+11): Oct 20 **08:43:15**, Oct 21 **08:33:05**, Oct 22 **09:24:59**, and Oct 22 **12:37:56**, respectively. Dates in filenames are UTC, not Australian local dates.

### Conversation size at the failing request

Counts exclude the failed assistant response. With no compaction/branch/context edits, the prior message sequence is the relevant conversation history. “Full request bytes” is Pi's diagnostic measurement of the original UTF-8 `JSON.stringify(body)`, including instructions, declarations, and converted conversation. It is **not an observed network frame size**: `auto` can send a smaller cached-context WebSocket delta using `previous_response_id`. The diagnostic measures `bodyJson` before that optimization (`AI/api/openai-codex-responses.ts:292, 356–365, 1426–1477, 1522–1530`). Thus neither raw transcript size nor this diagnostic proves a WebSocket frame exceeded a limit.

| Task | Prior messages (system/user/assistant/tool-result) | Pi full request bytes | Prior messages serialized bytes¹ | Last successful request's reported input + cache-read tokens² |
|---|---:|---:|---:|---:|
| `acp-adapters-a1` | **84** (1/1/33/49) | **330,972** | 358,135 | 2,871 + 68,352 = **71,223** |
| `phase2-review-r1` | **22** (1/1/4/16) | **226,644** | 230,337 | 17,487 + 13,824 = **31,311** |
| `db-runtime-d3` | **229** (1/1/87/140) | **859,613** | 1,189,755 | 724 + 141,696 = **142,420** |
| `observe-assess-o1` | **180** (1/1/82/96) | **699,402** | 976,399 | 1,769 + 103,424 = **105,193** |

¹ Compact Python JSON serialization of prior stored message objects, UTF-8, including signatures/metadata; a reproducible storage-size measure, not the API payload.

² Context-scale indicator only, **not exact failing-request token counts**: it predates the preceding response and subsequent tool results. Each failed response records all-zero usage, which means unavailable accounting here, not zero provider work. Exact tokenization of the failing request is not recoverable from these transcripts.

### Individual failing records

All use API `openai-codex-responses`, `stopReason: "error"`, `configuredTransport: "auto"`, `eventsEmitted: true`, `phase: "after_message_stream_start"`, and a `provider_transport_failure` diagnostic. None records a successful terminal response after the error.

- **`acp-adapters-a1`** – file has 88 lines / 391,364 bytes; terminal entry **line 88, `ca986467`**, previous tool result line 87 `f1bee769`. Model **`gpt-6.1-sol`, medium**. Error **`WebSocket error`**. Response ID `resp_011f6d8985bbc1fb016ad68e5c1b388191bfb8cda0cd0b1866`. Partial output contains an empty thinking block with a 2,618-character signature, **336 characters of text and a `write` tool call**. No result for that call follows. The agent loop checks error/abort **before** executing any tool calls, so this failed response's `write` is not executed through that loop (`AG/agent-loop.ts:241–270`). Successful earlier tools remain completed work.
- **`phase2-review-r1`** – 26 lines / 235,019 bytes; terminal **line 26, `e1916b70`**, previous tool result line 25 `ad5f2f3b`. Importantly, this earlier attempt used **`gpt-6-astra`, high**, **not** `gpt-6.1-sol`. Error **`WebSocket error`**; empty content array despite `eventsEmitted: true` and response ID `resp_000c486fc56000a4016ad7dd1c5bcc81919ca1343fee68fdbe`. A response-created event can start the stream without visible text.
- **`db-runtime-d3`** – 233 lines / 1,216,416 bytes; terminal **line 233, `ec09be72`**, previous tool result line 232 `21ddfe71`. **`gpt-6.1-sol`, medium**. Error **`WebSocket error`**. Response ID `resp_0797bd44006a1658016ad93b1c3000819186f2359513121e91`; only an empty thinking block, no text/tool call in the failing response. Diagnostic stack runs from `extractWebSocketError` through `WebSocket.onError`, Undici socket-close handling and `TLSSocket.onSocketClose`.
- **`observe-assess-o1`** – 184 lines / 1,006,754 bytes; terminal **line 184, `be23d022`**, previous tool result line 183 `78187d1a`. **`gpt-6.1-sol`, medium**. Error **`WebSocket idle timeout after 300000ms`**. Response ID `resp_00e69838af59466d016ad9669489148191ac5671552b4e7a6d`; two thinking blocks (one with 9,254-character signature, another with 239 thinking characters), no text/tool call. The whole request lasted over ten minutes; **300 seconds is the final no-event wait, not the whole request deadline**. Last event timing is not persisted, so it cannot be reconstructed exactly.

Original transcript locations (read-only):

```text
acp-adapters-a1:
/Users/nick/.switchboard/switchboard/runtime/487537935c922e003caf22a9e8b0108e8b13ff4b350a2a2e83e290c48314cd3c/f968c3e74abbd612724a1ac4d685dce6c051b834670df47dc80f3e02b014b406/sessions/2026-10-19T21-38-17-749Z_f94f167b-f925-4045-a6aa-f91baf402fef.jsonl
phase2-review-r1:
/Users/nick/.switchboard/switchboard/runtime/487537935c922e003caf22a9e8b0108e8b13ff4b350a2a2e83e290c48314cd3c/e2c74d3ce22913c6ccc42836f6de68ca6dc38c99e2b14b58f0146471f9a0a434/sessions/2026-10-20T21-26-20-605Z_ca19c20b-a7c7-42a8-9375-5db5c2f34ca2.jsonl
 db-runtime-d3:
/Users/nick/.switchboard/switchboard/runtime/487537935c922e003caf22a9e8b0108e8b13ff4b350a2a2e83e290c48314cd3c/89a7b8ac051da4ca3333c8bf0b482df904d210076af166f9e96614a1bed39a72/sessions/2026-10-21T22-03-04-038Z_efde09a2-c123-4d03-b08d-3b7b12b2fde2.jsonl
observe-assess-o1:
/Users/nick/.switchboard/switchboard/runtime/487537935c922e003caf22a9e8b0108e8b13ff4b350a2a2e83e290c48314cd3c/ce073903353e3bf3f0623d43491951ad42822eae65915c44cf2fb8db119afd53/sessions/2026-10-22T01-04-32-841Z_175c7ae0-4f3d-46c8-a561-b9711b2e42bf.jsonl
```

### Patterns and limits of inference

- Common pattern: a live Codex WebSocket failed **after** the provider began responding. Not initial authentication, connection setup, or an unacknowledged original user prompt. The precise RPC response records are not in these session files, so no claim is made that the transcript itself contains the RPC acknowledgement.
- Not confined to long sessions or one model: failures occurred around 5, 7, 22 and 33 minutes, with four to 87 prior successful assistant responses. One model/thinking setting differs. No common session lifetime threshold is evident.
- Request size varies by about 3.8× (226,644–859,613 full-body bytes); the two short sessions also fail. Large context could affect latency, but there is no control sample, exact failed token usage, or message-too-big close code. No demonstrated size threshold.
- Three errors happened in the Australian morning, one near midday, on three different days. Four selected failures without successful-request denominators/provider incident data cannot establish a time-of-day effect.
- The explicit 300000-ms case is a **proven client idle limit**. The generic errors' requests lasted about 151, 160 and 246 seconds, not 300 seconds. Do not attribute all four to that timer.
- Pi also has a five-minute **between-request socket cache expiry** and a 55-minute maximum reusable socket age. These are distinct from active-response idle timeout; expiry does not terminate busy cached sockets, and age is checked on acquisition (`AI/api/openai-codex-responses.ts:867–868, 1053–1073, 1164–1175`). None of these session durations reaches 55 minutes; actual connection creation times are not recorded.
- For the three generic errors, the missing event error payload/close reason prevents root-cause attribution. A TLS/socket close is visible in stacks, but the transcript cannot distinguish provider/proxy/network reset, client route change, or other underlying transport failure. No server logs, packet capture, proxy history, or provider incident timeline were available. Claiming a specific server timeout would exceed the evidence.

## 2. What produces these errors and what settings matter

### Error origin and transport fallback

`AI/api/openai-codex-responses.ts:1252–1270` extracts the event message or nested error; if neither is useful it returns the generic **`new Error("WebSocket error")`**. `parseWebSocket` records that error and ends the stream (`1350–1354`). Separate close events can carry code/reason (`1272–1292`), but these generic failures have no such useful reason in the retained record.

The same parser waits for queued incoming JSON events. While its queue is empty, a positive `idleTimeoutMs` starts a timer; expiry records the exact idle error, closes the socket with reason `idle_timeout`, and rejects (`1383–1410`). Incoming events wake it; after consuming events a new wait gets a fresh timer. It requires a terminal response event (`1412–1416`). This is an event-idle watchdog, not an attempt/session timer and not a limit on how long reasoning can run while events continue.

Provider code defaults to `transport: "auto"` and attempts WebSocket unless forced to SSE or already marked for fallback (`293–303`). It marks streaming started on the first mapped event (`1480–1492`). On transport error it appends diagnostic size/phase data, records fallback state, and **throws if streaming started**; before stream start it can fall through to SSE (`342–375`). It also has special one-time reconnect paths for missing continuation and connection-limit errors (`342–351`), independent of the agent retry switch. The failure marker is per session, maintained by `recordWebSocketFailure` (`967–987`), so a later call with that session ID skips WebSocket even though `auto` remains configured. The failed socket and its continuation state are discarded (`1581–1592`). This does not resume the same response ID at a byte offset; it generates a new response from conversation context.

### Settings (installed `docs/settings.md:119–135` and source)

| Setting/layer | Effect and relevance |
|---|---|
| `httpIdleTimeoutMs` | Default **300000**; HTTP headers/body idle limit. Despite the name, SDK also supplies this as Codex's default `timeoutMs`, and hence the WebSocket active-response idle timer. `CA/core/http-dispatcher.ts:4, 81–97`; `CA/core/settings-manager.ts:900–911`; `CA/core/sdk.ts:339–353`; `AI/api/openai-codex-responses.ts:293, 324, 1502–1515, 1550–1552`. |
| `retry.provider.timeoutMs` | Overrides that per-provider-call timeout in SDK option precedence: explicit call option, then provider setting, then effective HTTP idle default (`CA/core/sdk.ts:344–353`). Separate from enabling retries. Positive values govern Codex response-header waits and WebSocket event-idle waits, not total session runtime (`AI/...:397–412, 1395–1404`). |
| Zero timeouts | Docs say `httpIdleTimeoutMs: 0` disables the limit. SDK actually maps that inherited provider default to **2147483647 ms**; an explicit `retry.provider.timeoutMs: 0` remains zero and disables the provider timer. HTTP dispatcher zero disables its HTTP limits. Changing only the provider timeout does not remove the dispatcher's independent HTTP body/header limit on SSE. Prefer a finite tuned limit over relying on these differences (`CA/core/sdk.ts:345–350`; `CA/core/http-dispatcher.ts:81–97`). |
| `websocketConnectTimeoutMs` | Default **15000**, zero disables the connect timer (`AI/...:57, 1076–1147`). These failures were already streaming, so raising a connection-setup limit would not address them. |
| `transport` | `auto`, `sse`, `websocket`, `websocket-cached`; default `auto`. SSE bypasses initial WebSocket attempts. `auto`/`websocket-cached` can use cached-context deltas; plain `websocket` uses full context. SSE sends a full body, optionally zstd-compressed (`AI/...:296–303, 379–387, 1521–1526`). All still can suffer transport/idle failures. |
| Heartbeats / keep-alives | No application WebSocket ping/pong loop or configurable heartbeat interval in this provider. The exposed interface has open/message/error/close plus send/close (`AI/...:870–878`). Socket caching is reuse, not a heartbeat; prompt-cache warming is not a remedy for a stalled active response. OS/proxy/server keep-alives are not established by this transcript. |
| `retry.enabled` / RPC `set_auto_retry` | Agent-level transient retry switch, default true. Switchboard explicitly sets false (`src/runtime/pi/worker.ts:94–102`). RPC delegates to session settings (`CA/modes/rpc/rpc-mode.ts:547–549`), which writes the global settings manager (`CA/core/agent-session.ts:3855–3857`; `CA/core/settings-manager.ts:882–889`): not just a per-request network toggle. Review agent-directory isolation/persistence when changing it. |
| `retry.maxRetries`, `baseDelayMs`, `maxAgentDelayMs` | Defaults **3**, **2000**, **60000** (`CA/core/settings-defaults.ts:17–24`; `AI/utils/retry.ts:126–132`). Three consecutive retries give delays 2/4/8 seconds. Success resets the count, so this is not three retries total over an entire long task (`CA/core/agent-session.ts:1177–1185`). External time/cost limits still matter. |
| `retry.provider.maxRetries`, `maxRetryDelayMs` | Different layer. Codex defaults to zero provider retries (`AI/...:54, 389`). SSE HTTP request loop can resend the POST on retryable HTTP/network failures (`389–466`), with server delay cap; stream processing is after that loop (`469–480`), so raising this does **not** retry these post-start WebSocket failures. Do not confuse it with the needed agent-level retry. |
| Switchboard `requestMs` / `runMs` | RPC-command timeout / whole-attempt bound, not Codex stream idle limits (`src/runtime/pi/worker.ts:31–32, 94–106, 171–172`). Raising an RPC acknowledgement timeout is not a fix for these late provider failures. Retries do not grant a new attempt deadline. |

Configuration documentation says project settings override agent-directory settings after trust; user settings live under `~/.pi/agent` unless `PI_CODING_AGENT_DIR` is set. Current ambient settings are not historical evidence of each failed launch; the error/diagnostic fields establish the observed `auto` transport and 300000-ms idle value in the relevant requests.

## 3. Exactly what Pi automatic retry does

### Eligibility

`CA/core/agent-session.ts:3733–3737` first excludes context overflow (separate compaction recovery), then calls `isRetryableAssistantError`. The classifier requires `stopReason: "error"` and an error message, excludes account/quota/billing patterns, and matches transient text (`AI/utils/retry.ts:7–109, 253–258`). It includes overload/rate limits/429, 500/502/503/504/520/524, server errors, network/DNS/refused/lost connections, fetch failures, socket closure, **timeout**, **WebSocket error/closed**, premature terminal-event endings, and explicit retry guidance. Aborts are not eligible. This is a text classifier, not proof a failure is temporary; the RPC docs' short “overloaded, rate limit, 5xx” description is not exhaustive.

Both observed error strings match; the offline check calls the installed classifier with both and tests negative quota/billing/abort cases.

### Replay boundary and transcript effects

1. The RPC `prompt` handler calls `session.prompt` once and emits its acceptance response at preflight; errors after acceptance do not produce a second prompt response (`CA/modes/rpc/rpc-mode.ts:394–413`; installed `docs/rpc-commands.md`, Prompting).
2. `_prepareRun` constructs the initial user message **once** (`CA/core/agent-session.ts:1890–1920`). `_startRun` calls `agent.prompt(messages)` and then uses a post-run loop, calling **`agent.continue()`**, not `prompt`, when recovery is requested (`1843–1877`).
3. On failed assistant output, the low-level loop ends **before executing that response's tools** (`AG/agent-loop.ts:241–270`). `_handlePostAgentRun` selects retry (`CA/core/agent-session.ts:1937–1954`). `_prepareRetry` checks enablement/budget, emits `auto_retry_start`, omits the failed assistant from model projection, and waits with abortable exponential backoff (`3787–3828`).
4. Omission is append-only: `_omitRecoveryAttempt` appends a `context_edit` with `replacement: null`, preserving raw failed output/usage while refreshing projected context (`1240–1256`). It targets the failed assistant, not the user message or prior successful turns. No initial instruction is appended again, and no earlier successful tool result is erased for replay.
5. `Agent.continue()` snapshots current transcript and invokes continuation (`AG/agent.ts:383–410, 448–457`). `runAgentLoopContinue` begins with **`

*(The recovered text ends here.)*

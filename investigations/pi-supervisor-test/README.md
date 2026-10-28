# Pi as a supervisor host

The first check under step 11 of the [Phase 3 PRD](../../docs/phases/03-supervisor/PRD.md#the-supervisor): whether Pi can host the supervisor through a small Switchboard extension, before any of it is built.

## Questions

1. Does a session started with only extension tools have no shell, editing or file-writing tools?
2. Does `pi.sendUserMessage()` start a turn when Pi is idle, and what happens when it is sent in the middle of a turn?
3. Does background code in an extension keep running across turns?

## Method

[`extension.ts`](extension.ts) registers two tools, `sb_status` and `sb_slow` (which takes ten seconds), records Pi's active tools, writes a heartbeat every two seconds, and sends events with `pi.sendUserMessage()`:

- while `sb_slow` runs (mid-turn): one message without `deliverAs`, and one with `deliverAs: "followUp"`;
- five seconds after the first run ends (idle): one message, sent either without `deliverAs` or with `deliverAs: "followUp"`.

[`driver.ts`](driver.ts) starts Pi in RPC mode with `--extension extension.ts --tools sb_status,sb_slow` and no skills, prompt templates, context files or MCP, sends one prompt asking the model whether it has a shell and to call `sb_slow`, and stops once the model has replied to the idle event.

From the repository root:

```sh
node investigations/pi-supervisor-test/driver.ts /opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js .investigation/pi-supervisor-test/run-1
PI_TEST_IDLE_MODE=followup node investigations/pi-supervisor-test/driver.ts <same cli.js> .investigation/pi-supervisor-test/run-3
```

Each run writes `extension.jsonl` (what the extension observed), `rpc.jsonl` (Pi's RPC output) and the Pi session under the output directory.

## Results

Three runs on 28 October 2026, macOS, Node.js 26.7.0, Pi coding agent 1.4.0, `openai-codex/gpt-6.1-sol` at low thinking: five model requests and about 3,700 tokens each, US$0.008 per run at catalogue prices.

1. **No shell.** `getActiveTools()` and `getAllTools()` both returned only `["sb_status", "sb_slow"]`, before and during every run. The model answered `NO_SHELL` and listed only those tools (plus the provider's own parallel tool-call wrapper).
2. **Idle delivery starts a turn.** An event sent while Pi was idle started a new run at once (`before_agent_start` with `messageType: "user"`), with or without `deliverAs: "followUp"`.
3. **A follow-up sent mid-turn is delivered after the turn.** Pi queued it (an RPC `queue_update` event listed it as a follow-up) and delivered it as the next user message once the current run's turns ended; the model answered it.
4. **A message sent mid-turn without `deliverAs` is silently lost.** In every run the call resolved without error (awaited or not), but the message never reached the conversation, the session file or the RPC output. Pi's own `send-user-message.ts` example says such a call throws; in 1.4.0 it does not.
5. **Background code keeps running.** The heartbeat continued through every turn and while idle (14 beats over about 30 seconds in the first run), until `session_shutdown`.
6. `ctx.isIdle()` is still `false` inside the `agent_end` handler and becomes `true` shortly after, so an event cannot be sent from that handler as if Pi were idle.

## Consequences for the supervisor extension

- Restrict the supervisor session with `--tools` naming only the extension's Switchboard tools. Pi then declares no shell, editing or file-writing tools to the model.
- Deliver every event with `pi.sendUserMessage(text, { deliverAs: "followUp" })`, whether or not Pi is idle. That starts a turn when idle and queues the event otherwise, and avoids checking `isIdle()` first, where a change of state between the check and the send would lose the event silently.
- Run `wait --objective` in the extension's background code; it keeps running across turns. Record an event as handled in Switchboard only after Pi has delivered it to the model (for example on the `before_agent_start` or `message_start` that carries it), so an event lost before delivery is offered again by the next `wait`.

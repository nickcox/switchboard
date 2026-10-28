# Questions from workers

A worker can ask a person a question while it works. A future supervisor will use the same operations, within its objective's `answerQuestions` permission. Questions are records of an attempt, not changes to the task's instructions or authority.

## Asking through files

Switchboard assigns each worker a `questionsDirectory` outside its workspace, under its attempt's runtime directory. The path is in the worker's input and prompt. Pi still runs in RPC mode with extensions disabled; the worker uses its standard write tool, just as it writes its result file.

Write one JSON object in a new file, for example `design.question.json`:

```json
{
  "text": "Should the command keep the existing output format?",
  "choices": ["Keep it", "Use the proposed format"],
  "waiting": true
}
```

- `text` is required, nonblank and at most 16,000 characters.
- `choices` is optional. When supplied it contains 1 to 20 nonblank strings, each at most 1,000 characters.
- `waiting` is a required boolean. It tells the reader whether the worker is waiting; it does not pause the worker or extend its deadline.
- No other fields are accepted. The complete UTF-8 file must be at most 32 KiB.
- Use a unique name ending in `.question.json`. The part before that suffix must start with a letter or digit, contain only letters, digits, dots, underscores or hyphens, and be at most 120 characters long.

Publish each complete file in one write-tool call. Do not edit or reuse it. The supervising dispatcher reads new files on its existing control-request polling interval, and once more when the worker finishes, so a short run's questions are not missed. Other filenames, including answer files and temporary files, are ignored. The first reading of a filename wins: malformed JSON, an invalid schema, an oversized file or a non-regular file is recorded as **invalid**, with a diagnostic, never as a question. Editing an invalid file does not fix that record; ask again with a new filename. Symbolic links are not followed.

A valid question gets a Switchboard-generated ID and an immutable record containing its context, task, attempt, filename, text, choices, waiting flag and the time it was read. The worker does not need to choose or know that ID to check its answer file.

A waiting worker should continue other useful work or check for the answer file at intervals, rather than end its run. Neither a waiting question nor an answer changes the run's time or cost limits.

## Inspecting and answering

`status` and `watch` show questions and IDs, choices, whether the worker is waiting, answers and delivery outcomes. JSON status includes questions under each attempt and a context-wide `openQuestions` list, including questions whose attempts have been archived. Invalid files have their own diagnostics, separate from valid questions.

```sh
switchboard status
switchboard watch --task implementation --no-follow
switchboard answer --task implementation --question <question-id> "Keep the existing format"
```

`answer` accepts `--config`, `--json` and `--wait <seconds>` (default 10). It records one nonblank answer of at most 16,000 characters, its caller and timestamp. A second answer, an unknown question or a question belonging to another task or context is refused. No attempt selector is needed: the question ID identifies its attempt, even if a later attempt is now working on that task.

Authority is checked inside the operation and its answer transaction. A person uses their host-supplied caller identity. A supervisor must own the task's current objective and have `answerQuestions`; it does not also need `steerWorkers` to deliver this answer. Model arguments cannot supply a different caller. Existing safety checks still apply, and an answer cannot grant permission or replace the instruction snapshot or delivery contract.

## Delivery and outcomes

The answer and, when there is a fresh owning dispatcher and no observed or confirmed exit, its control request are committed in one transaction. The dispatcher claims the request through the existing stop/steer protocol, forwards it at most once and records the outcome. Pi receives steering while streaming, or a follow-up when it is between turns. The message names the question ID and filename, quotes the answer, and says that the answer is guidance, not authority. There is no replacement prompt, second launch or attempt restart.

Switchboard also writes an answer file next to the question, replacing the `.question.json` suffix with `.answer.json`. For example, `design.answer.json` contains:

```json
{
  "questionId": "12345678-1234-4234-8234-123456789abc",
  "question": "Should the command keep the existing output format?",
  "answer": "Keep the existing format",
  "answeredBy": "operator:example",
  "answeredAt": "2026-10-28T12:00:00.000Z"
}
```

The database is authoritative; the answer file is a convenience for the worker. File and message outcomes are recorded separately. A queued RPC message means Pi accepted it, not proof that the worker read or followed it. A request not claimed within `--wait` is withdrawn and recorded as undelivered; a claimed request is never resent, even if its dispatcher stops before recording a result. A file write failure is recorded, without overwriting an existing file or permitting another answer. A pending outcome after an interruption means delivery has not been established.

Successful `answer` means the answer was **recorded**, not that either delivery channel succeeded. Inspect its reported outcomes. A finished worker gets no control request; its answer file is still written if its runtime directory remains. After pruning, the file is unavailable but the question and answer remain in the database.

## Continuing the work

A question still open when its worker finishes stays open. Finishing, returning the workspace and pruning do not silently close or delete it. A late answer never starts that worker again.

A reservation made with `dispatch --from-attempt` includes open and answered questions across the task's attempts in its immutable written handover, with their choices, waiting flags and recorded answers. Answers recorded after that reservation do not rewrite its instruction snapshot. The new worker is again told that answers are guidance, not authority.

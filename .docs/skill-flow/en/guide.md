# Executable skills

In a Cheshi checkout, each skill can define input parsing, an execution function, and a result validator.
The shared runner handles Jev judgments, Luna fallback, artifact path checks, and `success` / `fail` records.
Adding a skill does not require changing a central registry.

When explicitly invoked, a skill sends the supplied judgment input to TypeSafe's Jev.
If Jev is unavailable, the same judgment input is sent to OpenAI's Luna low through the Codex login.
The history recall permission switch in Settings applies only to conversation history tools; it does not control this CLI execution.
Jev consumes TypeSafe usage, while Luna uses the Codex account.

## File structure

Place these two files in `.agents/skills/<name>/`:

- `SKILL.md`: `name` and `description` frontmatter, input requirements, and execution instructions. This is the usage guide read by the agent.
- `workflow.mts`: a default export of an execution definition created with `defineSkill()`.

Names must contain only lowercase letters, digits, and hyphens, with a maximum of 64 characters.
Code blocks in `SKILL.md` are not executed directly.
Modules are trusted repository code and run with the permissions of the invoking command. They are not separately sandboxed.

## Example function

This example assumes the file is at `.agents/skills/condition-note/workflow.mts`.

```ts
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { defineSkill } from '../../../desktop/lib/skill-flow-definition.mts';

export default defineSkill({
  name: 'condition-note',
  parseInput(value: unknown) {
    if (typeof value !== 'string' || !value.trim()) throw new TypeError('String required');
    return value;
  },
  async run(ctx, input, env) {
    const urgent = await ctx.jev({ state: input, condition: 'Is this an urgent request?' });
    const file = path.join(env.directory, 'note.md');
    await writeFile(file, urgent ? 'Urgent handling' : 'Normal handling', { flag: 'wx' });
    return { outcome: 'success', artifacts: [file] };
  },
  async validate(result, _input, env) {
    const file = path.join(env.directory, 'note.md');
    if (result.artifacts?.length !== 1 || result.artifacts[0] !== file) return false;
    return ['Urgent handling', 'Normal handling'].includes(await readFile(file, 'utf8'));
  },
});
```

`ctx.jev()` returns an actual boolean. A valid `no` follows the `else` branch and does not mean the task failed.
The execution function's `outcome` and the validation result determine final success. A function may also finish without making a judgment.
A Jev error triggers one fallback to Luna low/default. Valid `no` results, cancellation, and invalid input do not trigger fallback.
If both providers fail, an exception is raised and the runner records a failure. No score threshold is used.

The validator must return literal `true`. The string `"true"` is a failure.
Validators can also call `ctx.jev()`. Artifacts must be actual files within that run's directory.
The runner does not undo a skill's external side effects, so write skills to validate before saving.
Pass `env.signal` to cancellable operations and define termination conditions, such as iteration limits, within the skill.
The runner defaults to 5 minutes and 64 calls to `ctx.jev()`. One judgment, including any Luna fallback, counts as one call.
Exceeding a limit records `timeout` or `call_limit`; cancellation records `canceled`. Further judgment calls are blocked.
The runner stops waiting even if execution or validation ignores cancellation and remains pending.
It does not undo side effects or forcibly stop code that remains in the same process.
The CLI monitors a separate process and forcibly terminates it if it exceeds the overall time limit or fails to exit within 5 seconds after cancellation.
In that case, `result.md` may be absent. Termination of separately spawned child processes or external tasks is not guaranteed.

## Running and extending skills

```sh
bun run scripts/skill-flow-run.mts --skill condition-note --input out/skill-flow/request.json
```

Configure limits with `--timeout-ms 300000 --max-judgments 64`.
The maximum duration is 1 hour and the maximum judgment count is 1,000; both values must be positive integers.
For programmatic use, pass `timeoutMs` and `maxJudgments` to `runRegisteredSkill()`.

The example input is the JSON string `"Please check tomorrow"`. This illustrates how to write a skill; it is not installed by default.
The currently installed skill is `jev-research-report`, which uses the same command with its skill name.
Input JSON must not exceed 32,000 UTF-8 bytes.
The key is read from the existing Cheshi store, and the Codex account's `CODEX_HOME` is preserved.
On success, the CLI prints the artifact paths and `result.md`. On failure, it records the reason in `result.md` if execution has started.
Module loading or output storage failures may end the process without a report.

For programmatic use, combine `createSkillRegistry([skillA, skillB])` with `runRegisteredSkill()`.
Inject external tools through `dependencies`; each skill checks the contracts it requires.
The default CLI provides a `research` tool. Skills requiring other tools need those tools implemented or connected through dependency injection.
This runner is currently intended for a source checkout and is not included in the distributed app.

## Validation coverage

Regression tests inject malformed yes/no responses, task results, validation results, citation numbers, links,
missing requirements, unread sources, cancellation, missing files, and paths outside the run directory.
The research skill fetches original sources separately, compares them with the notes, and uses Jev to check the completed document's requirements and citation support.
Content actually read is stored in `evidence-*.json` in the run directory.
Rejected or unreadable sources are excluded, with reasons recorded in `sources-*.json`.
Accepted sources are retained, and insufficient material triggers up to two additional research rounds. Communication and provider errors are not treated as valid `no` results.
When source count or size limits are exceeded, existing and new material are compared using Jev yes/no judgments about which better serves the requirements.
The comparison sequence selects up to 6 sources within 23,000 bytes, after which sufficiency is evaluated again.
No score or confidence threshold is used. Comparison calls count toward the overall judgment limit.
`selection-*.json` records all candidates, comparison results, selected URLs, and URLs excluded by the limits with their reasons.
Model comparisons do not guarantee an optimal ordering or retention of essential evidence, so the sufficiency check remains required for the selected material.

Document bodies are checked as Markdown. Ordinary lists, inline code, and code blocks are allowed; actual links, images, and HTML are rejected.
Underscore placeholders such as `answers.<question_id>` are also allowed outside code and are escaped on save so they appear as literal text.
Source titles are handled safely, and the assembled document's actual links are checked against the validated citation list.

Writing is limited to an initial attempt and up to two rewrites. Invalid JSON, structure, citations, body formatting,
unmet requirements, and insufficient evidence trigger a new draft with specific error codes and field locations.
A rewritten document must pass structural and semantic validation again before it is saved. Provider errors, cancellation, and exhausted time or judgment limits do not trigger rewrites.
Starting with `writing-1.json`, each attempt records the raw response, acceptance status, and errors.
Raw response records are limited to 64,000 UTF-8 bytes. Exceeding this limit marks the record as truncated and fails the attempt.
Feedback includes the previous response only if it is untruncated and within 18,000 bytes. Internal messages from provider exceptions are not recorded.

Large citation validation requests split the body by sentence while retaining the complete citation evidence.
Request body size is checked using the same serialization as actual Jev requests. Sentences and evidence are not silently truncated.
If a single sentence cannot fit within the limit together with all the evidence, validation fails. The writing tool is instructed to use short sentences.
Long web sources are read from the beginning up to the reading limit, so evidence appearing only later may be rejected during validation.

Run the runner's regression tests with `bun run skill-flow:test`. They are also included in the default `bun run test` command.

Code cannot detect every case where the semantic validation model returns `yes` for incorrect content.
Tests expose this limitation by intentionally injecting an incorrect `yes`.
Blocked web pages or reading limits may prevent completion of a report.
The runner does not guarantee recovery or resumption of arbitrary tasks beyond research supplementation and document rewrites, conversion of arbitrary skills, or automatic connection of every tool.

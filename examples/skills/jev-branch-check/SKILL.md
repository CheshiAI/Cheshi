---
name: jev-branch-check
description: Test natural-language if/else with Jev against collected research and record success or fail in Markdown. Use for the Cheshi skill-flow prototype; it does not generate PPT files.
---

# Jev branch check

Run this example from the Cheshi repository root. It uses the exported
`branchCheck(ctx, question)` function in [workflow.mts](workflow.mts).
`SKILL.md` tells the agent what to run; its code blocks are not automatically executed.
This example is repository-local and is not automatically installed in the skill catalog.

The workflow calls `ctx.jev({ state, condition })`. The adapter asks Jev to choose
`yes` or `no` with a Choice question and follows the returned `choice` directly:

| Jev choice | `await ctx.jev(...)` | Markdown first line |
| --- | --- | --- |
| `yes` | `true` | `success` |
| `no` | `false` | `fail` |
| unavailable key, request failure, or malformed response | throws `SkillFlowDecisionError` | `fail` |

Use the boolean directly in `if (judgment)`. The runner keeps decision metadata
for reports; workflows return only `{ outcome: 'success' | 'fail' }`.
Request errors throw before either branch executes. The runner records them as
`judge_error`, with a distinct error reason and null value. The adapter does not read, compare,
or expose response probabilities or confidence. No numeric decision policy is applied.

Run the deterministic local cases:

```sh
bun run scripts/skill-flow-demo.mts
```

This uses mock responses for the research cases, HTTP failure, and malformed
response cases. It never contacts TypeSafe. The summary's `success` means all
expected branches were observed, including cases whose own output is `fail`.

To test Jev itself using the key already saved in Cheshi Settings, run:

```sh
bun run scripts/skill-flow-demo.mts --live
```

The CLI starts this checkout's Electron runtime without opening a window. It
reads the saved encrypted key using `safeStorage`, as the previous Jev benchmarks
did. The key stays inside that process; it is never printed or copied to a file.
The runtime uses a temporary data directory so the app's existing data is unchanged.
An explicit `TYPESAFE_API_KEY` or `TYPE_SAFE_AI` environment value takes precedence.

Live mode sends three variants of the official-source notes in `workflow.mts`:
all three sources, only the Noul source, and no sources. These notes were gathered
from TypeSafe's Noul/HTTP API documentation and LangChain's Interpreter Skills
article on 2026-09-21. The requested presentation covers Noul semantics, the HTTP
contract, and executable-skill roles. Expected results are yes/no/no, fixed before
calling the model. This small check does not establish general research quality.

The runner evaluates those notes; it does not browse or refresh sources itself.
Each run saves the exact notes and question in `inputs.md` beside the summary.
It uses `jev-latest`, a 20-second request timeout,
and no retries. The returned model version and available token counts appear
in the case reports. Missing usage stays `unknown`. Do not put keys in commands,
reports, or code.

Both modes print the summary path under a new `out/skill-flow/<mode>-<id>/`
directory. Use `--output-root DIRECTORY` to change its parent. Existing reports
are never overwritten. A failed expectation sets exit code 1 after saving the
report. Report-write failures also exit with an error, rather than claiming a
saved result. No research/PPT tools or desktop chat behavior are changed.

Validation:

```sh
bun test desktop/test/skill-flow-judge.test.ts desktop/test/skill-flow-runtime.test.ts
bun run desktop:typecheck
bun run codegraph:server:typecheck
node --input-type=module -e "await import('./desktop/lib/skill-flow-runtime.mts'); await import('./scripts/skill-flow-demo.mts')"
```

API references: [HTTP API](https://docs.typesafe.ai/api),
[Choice selection](https://docs.typesafe.ai/primitives/choice).

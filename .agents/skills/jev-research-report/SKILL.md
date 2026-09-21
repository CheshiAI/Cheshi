---
name: jev-research-report
description: Research a topic and produce a source-linked Markdown report using Jev yes/no decisions, up to two additional web research rounds, and Luna low fallback when Jev is unavailable. Use when a user wants this executable research workflow in the Cheshi checkout.
---

# Jev research report

Run this skill from the Cheshi repository root. The registered workflow executes
real web research and Markdown writing; it is not the mock branch demo.

1. Derive a topic and 1–8 concrete requirements from the user's request. Use the
   requested language. Reuse available source notes when relevant; do not invent
   evidence to make the initial judgment pass.
2. Write a request JSON file under a task-specific directory in `out/skill-flow/`:

   ```json
   {
     "topic": "JevのChoiceとNoulの違い",
     "requirements": ["それぞれの返り値", "コードでの分岐方法"],
     "sources": []
   }
   ```

   Optional sources are objects with `title`, public HTTP(S) `url`, and `notes`.
   At most six sources are accepted. Keep notes within 1,600 characters each and
   the complete evidence within 23,000 UTF-8 bytes. These limits bound request
   size; they do not decide whether the evidence is sufficient.
3. Invoke the registered skill:

   ```sh
   bun run scripts/skill-flow-run.mts --skill jev-research-report --input out/skill-flow/REQUEST.json
   ```

   Substitute the actual request path. Preserve the invoking account's
   `CODEX_HOME`; do not switch accounts or copy credentials. This requires the
   checkout's Electron runtime, a Codex subscription with Luna low, and network
   access. The existing saved Jev key is read inside a headless Electron process.
4. Open the printed `result.md` and, on success, `report.md`. Present the report
   link and any material limitations. `fail` means the workflow did not produce
   a completed report; do not substitute a made-up successful result.

Jev selects `yes` or `no`; `ctx.jev()` returns a boolean. Insufficient evidence
triggers additional research. A rejected draft triggers a new writing attempt,
whose new contents are checked again. Normal `no` never triggers Luna reassessment
of the same judgment. Jev service errors or unavailable
credentials trigger one Luna low/default decision using the same state and
condition. Cancellation and invalid inputs do not trigger fallback. If both
providers fail, the run records an error and stops.

Source URLs are fetched independently and their readable text is stored in evidence files.
Jev checks whether each source supports its notes. Unreadable or rejected sources
are excluded and recorded in `sources-*.json`. Previously verified sources are
retained while they fit; at the capacity limit, Jev compares old and new sources
for usefulness to the requirements. `selection-*.json` records comparisons and
excluded sources. Insufficient evidence triggers the remaining research rounds.
The first sufficiency `yes`
proceeds to document writing. Each finished requirement and section is then checked
with Jev yes/no. Markdown parsing permits literal code, arrays and placeholders
while rejecting active prose links, images and HTML. Final rendered citations
are checked against the verified sources.
Writing has at most three attempts. Validation failures provide error codes and
field paths to the next writing attempt; `writing-*.json` retains the response,
status and issues. Provider errors, cancellation and execution limits do not
trigger a rewrite. Raw draft capture is capped at 64,000 UTF-8 bytes and marked
when truncated; only untruncated drafts within 18,000 bytes are sent as feedback.
Large citation checks split the prose at sentence boundaries while retaining all cited notes.
A single sentence that cannot fit with its evidence fails validation without truncation.
Only a validated document is saved as `report.md`. After two additional research
rounds, another `no` stops with `fail`. Research may use web search; judgment and
writing cannot use tools. The runner records input, researched evidence,
decisions, provider attempts and Codex usage separately under a unique directory.
It preserves prior output files and never installs an autopilot loop.

`SKILL.md` is discovered through the standard repository skill catalog. The
agent invokes the command; `workflow.mts` exports the executable skill definition.
The generic registry loads that module and runs its input, execution and validation functions.
These modules are trusted repository code and run with the command’s permissions.
The runtime does not equate a Jev `no` with a failed task. Selecting a skill
alone does not silently execute code. The skill currently requires this checkout
and is not bundled into released Cheshi applications.

The default execution budget is five minutes and 64 judgment calls. Set
`--timeout-ms` and `--max-judgments` explicitly when needed. Cancellation, timeout
and exhausted judgment budgets stop waiting and prevent further judgments.
The CLI forcibly stops its execution process after a five-second grace period
if it remains stuck; in that case a result report may be unavailable. In-process
execution does not roll back side effects or forcibly stop arbitrary skill code.
See [the executable skill guide](../../../.docs/skill-flow.md) for the full contract.

---
name: homie-create
description: Create a Cheshi Homie through the New Homie interface, configure its account, model, and project permissions, and verify its repository, Explorer entry, and worker readiness. Use for requests to create a Homie; not for exporting a package, writing a generic agent prompt, or deleting a Homie.
---

# Create a Cheshi Homie

Use the user's installed release of Cheshi and its existing **New Homie** workflow. The result is a registered Homie
with its dedicated repository and the requested execution setup. A folder,
`agent.json`, or exported pack alone is not a created Homie.

Do not change Cheshi application code to perform ordinary creation. Do not
replace the UI workflow with direct registry, IPC, database, or internal service
mutations. File reads and interfaces verified to be read-only can support
verification. Do not infer this from an action named `status`: `HomieSources.status()`
can create backups and migration records, and convert legacy manifests and assets.
Do not invoke it directly as a read-only probe; let the authorized UI workflow
perform those operations.

## Establish the configuration

Resolve the requested name, purpose, account, model,
reasoning effort, service tier, project assignment, and execution permissions.
Reuse explicit choices from the conversation. Ask only for choices that are
missing and materially affect the result. Do not silently use **Configure later**
to claim a ready-to-use Homie; that is appropriate only for an explicitly
requested draft or deferred setup. Do not silently grant broad write or command
permissions or pick a more expensive model.

Normal creation prepares a private GitHub repository and its initial commit,
push, and local clone. Explain these effects when they are not already clear
from the task. Apply existing authorization and approval rules; a skill is not
additional permission to mutate GitHub or the local environment.

Check for an existing Homie with the requested name before creating another.
Check the intended local folder and repository identity. Do not pre-create
`homie-<name>`: the normal workflow reserves the path and may add a suffix when
it already exists. Preserve existing files and resolve actual collisions before
submission. Do not silently delete, overwrite, or rename another project's data.

### Choose execution permissions

Use these role presets as starting points within the user's authorized scope.
Honor explicit limits and enable only capabilities needed for the requested work.

| Specialty | Allow agent file changes | Allow agent commands |
| --- | --- | --- |
| Development / Frontend | On | On |
| Verification | Off | On |
| Planning / Research | Off | Off |
| Custom | Start off; choose from the requested work | Start off; choose from the requested work |

A fresh form starts with the Development preset: both permissions are on.
Changing **Specialty** resets both switches; imported packs and restored drafts
can supply different values. Select the specialty first, then explicitly set
and read back both switches. Recheck them after any specialty or pack change.

Confirm the intended assignment's absolute project path. **Assign agent to this
project** refers to the currently selected workspace; the generated Homie
configuration repository does not establish that assignment. Do not infer the
Homie's grants from the creating chat session's approval mode.

The manifest's `requestedPermissions` can seed a new imported form, but is not
an authorization record. Editing it or applying repository changes does not
change an existing Homie's saved grants. Execution uses the target project's
assignment permissions when present, otherwise the Homie's saved profile
permissions. Change authorized grants through that project's Homie settings,
save them, and apply or start the idle worker before claiming they took effect.
Project permissions do not grant network access or access outside the project.

## Use the actual creation interface

Interact with the user's current Cheshi release through available, authorized
UI tools. This workflow does not require a development app or a source checkout.
If the available tools cannot interact with the installed app, explain the
limitation and provide the remaining UI steps without claiming completion.

1. Open **Worker** and click the right-hand **New Homie** plus button using real
   mouse input. Confirm the creation form is visible and has no unrelated draft
   that would be overwritten.
2. Enter the name, specialty, and description. Select the agreed local account,
   available model, reasoning effort, and service tier. Confirm the target project,
   set **Assign agent to this project** and both permission switches as resolved
   above, and confirm the selected Docker execution engine.
3. Read back the visible field values, including both permission switches after
   specialty selection, and the enabled state of **Create agent**. Preserve the
   user's unsaved chats and unrelated editor content.
4. Click **Create agent** once. Observe saving, repository preparation, and
   worker startup. Wait for an actual completion or error state. Do not substitute
   `agentRegistry.save`, direct IPC calls, or service calls for this action.
5. If any stage fails or times out, inspect the saved Homie and the failure before
   retrying. Registration may already have succeeded. Resume the existing Homie
   through its settings and **Start agent** controls; do not create a duplicate.

## Configure the generated repository

After normal creation, open Explorer and expand the new Homie's project.
Read its absolute directory from the project row's tooltip, or use **Copy full
path** on its `agent.json` and take the parent directory. Verify the checkout's
Git remote matches the created repository. Do not derive the path from the Homie
name: the actual folder may have a collision suffix. The settings source panel
shows repository errors and actions; it does not necessarily display the path.
Read the located repository's `AGENTS.md` when present.

Edit the generated `agent.json` and `instructions.md` in place for the requested
role. Preserve the generated package `id`, `schemaVersion`, `instructionsFile`,
and unrelated settings. A different valid package ID can pass standalone parsing
but will be rejected when applied to this Homie. Put any needed portable assets
under `skills/`, `scripts/`, or `resources/`, following the existing file manifest.

Keep credentials, account IDs, local assignments, and conversations out of
portable files. Do not invent
connected tools: instructions describing iOS or browser automation do not install
or connect those capabilities.

### Validate and apply

For the installed app, return to the saved Homie's settings after editing and
wait for its repository check. Resolve any repository validation error before
applying. An enabled **Apply changes** button alone is not proof of validation
or application. For a ready-to-use request, click **Apply changes** once, or use
**Start agent**, and wait for the operation to finish. Confirm **Ready**, signed-in
status, and the absence of repository or startup errors. This operation validates
and applies the files and can start or replace the worker; it is not a read-only
validation preview. Respect busy-worker safeguards and report a blocked or pending
application instead of claiming completion.

If a matching Cheshi source checkout and Bun are already available, an optional
read-only package check can run from that checkout, with the actual manifest path:

```sh
bun -e 'import { readAgentPackage } from "./desktop/lib/agent-management/packages.mts";
await readAgentPackage(process.argv[1]);
console.log("Homie package valid");' "/absolute/path/to/homie/agent.json"
```

This parses the manifest, instructions, and resources. It does not apply changes,
verify the saved package identity, authenticate the worker, or prove readiness.
Do not require a checkout or launch a development app merely for this check.
For an explicitly stopped or draft Homie, do not start it just to validate files.
If full package validation is unavailable, report it as unverified; JSON syntax
checking alone is insufficient.

Tool-catalog changes can require a new conversation. Keep subsequent Git commits
and pushes separate from the creation workflow and follow the user's authorization
for them.

### Interpret permission messages in Chats

The initial chat intake deliberately disables file changes and shell tools,
even when the saved project grants allow them. The Homie must register or resume
work with `start_goal` or `continue_goal` before execution uses those grants.
Do not diagnose intake restrictions as failed setup, broaden permissions, or ask
for the same already-granted capability again. Inspect saved grants and the task
stage first; do not send a test message solely to trigger execution.

If execution actually lacks a required grant, use the Homie's normal Chats
permission-request flow and wait for the user's decision on the permission card.
Creating a permission request does not grant it. Respect the user's decision;
do not silently approve the card, edit internal storage to bypass it, or
override a denial.

## Verify the requested outcome

Check these independently:

- Exactly one matching Homie exists in the Homie list. Reopen its settings in the
  target project and verify the saved account, model, reasoning effort, service
  tier, assignment path, and both permission switches against the resolved setup.
  A manifest's requested permissions alone do not satisfy this check.
- The expected private repository and local checkout exist and match each other.
  The repository preparation error is absent.
- The correct `homie-<name>` project is visibly present in Explorer. Open the
  Explorer tab, allow transitions to finish, and inspect the row. Presence in a
  hidden DOM subtree or a project list alone is not visual confirmation.
- For a ready-to-use creation request, the worker is authenticated and ready,
  with no unresolved startup error. Repository creation does not prove this.
- The generated instructions and settings were validated and applied. Distinguish
  configured tool definitions from tools that were actually connected and tested.

Do not send a test message or run an external action solely to prove readiness
unless the user authorized that test. If the user requested only a draft, report
the unconfigured or stopped stages explicitly.

Remove task-owned temporary probes after verification. Track any backup created
to resolve a collision: restore it on failure or remove it after success only
within the user's cleanup authorization. Do not leave a backup unexplained or
delete data simply to obtain a clean status. Do not recreate a Homie when the
current request is only to write or revise this skill.

Report the saved account, model, reasoning effort, service tier, assigned project
path, file-change and command permissions, Docker engine, and worker readiness.
Include outstanding setup, any retained backup, and local changes that have not
been committed. Never equate package validation, registration, repository creation,
and worker readiness.

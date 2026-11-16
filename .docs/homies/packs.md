# Homie packs

Open Worker, then the Homies button at the right end of the conversation header.
The central management screen lets you create a Homie, edit its settings and
join a work room. Joining preserves the room's participants and default Homie;
it does not submit a task. Runtime exposes the existing Start, Stop, status and
logs controls. Choose the local account, project and execution permissions before
starting a worker.

## Create and share

Creating and editing a Homie use the same screen. The header contains the Homie's
name, **Create agent / Save agent**, and **Export…**. The left navigation opens:

- **Basic information**: name, icon, description, specialty, account and model.
  Expand **Homie pack** here to import a pack or change its version.
- **Instructions**: common instructions, linked Markdown and project instructions.
- **Skills**: create, edit and import reusable skills.
- **Tools**: tool groups and project execution permissions.
- **Files and environment**: project assignment, work-room participation, programs,
  scripts/documents and the saved Homie's Docker runtime controls.

Switching sections retains the same draft. Save persists the Homie directly;
there is no separate pack editor or apply-to-Homie step. Docker controls operate
on saved settings. Navigation and saving do not start or restart a worker.

The editor supports:

- Name, description and instructions copied from the current Homie. Pack IDs are
  generated automatically; version is under **Homie pack**.
  The model can be edited directly under **Basic information**.
- Skills created from a name, usage description and instructions; the editor
  generates the folder and `SKILL.md`. Existing skill folders can also be selected.
  Imported front matter is preserved in the Markdown editor.
- CodeGraph, collaboration and verification tool groups. Disabled groups are
  removed from new conversations and rejected on retained conversations as well.
  Newly enabled tools require a new conversation because native conversations
  retain their original tool catalog. Verification requests and integration
  require both collaboration and verification.
- Add/remove program lists with common programs and an advanced Debian package
  name field, optionally `name=version`, for the Linux environment.
- UTF-8 files under `skills/`, `scripts/` and `resources/`. A skill needs
  `skills/<name>/SKILL.md` and can include scripts and other relative resources.
  Add scripts/documents through file or folder selection; folder structure is
  retained. Existing paths are never silently overwritten. Assets currently use
  ASCII paths without spaces, and the combined UTF-8 asset limit is 8 MiB.

**Save agent** saves the full Homie configuration, including skills, files and
environment settings. **Export…** writes the current draft's portable
`<id>-<version>.homiepack.json` through the native save dialog, without saving or
starting the Homie. Import this file on another computer, choose its local account
and project, then save and start its Homie. Legacy `agent.json` plus
`instructions.md` packs remain supported. Importing a pack still previews it
before installing it in the user-data `homie-packs/` library and loading the draft.

Exports use the current editor's instructions, model and requested permissions.
Linked common Markdown instructions are copied into portable resources; their
host paths are not stored. Accounts, credentials, project assignments, project
rules, conversations and running containers are not part of the pack.
The linked source files remain local and are not modified by export.

## Runtime

At Start, Cheshi snapshots the selected pack and prepares an image derived from
the common worker image. It installs the listed Debian packages and copies assets
to `/opt/cheshi/homie-pack/`. Assets are read-only in the running container.
The worker installs skill directories into its private Codex home's `skills/`
directory using the reserved `cheshi-homie-` prefix. Personal skills outside this
namespace are preserved. Pack instructions include the asset paths; scripts use
the Homie's existing command permissions.

The derived image is cached by the base image identity and pack resources.
Status reads and CodeGraph queries do not build images. Changes take effect on
Start; existing busy/unfinished-work safeguards still govern container replacement,
and the private conversation volume is retained. Package installation failures
are shown by the existing Runtime error display.

Packs contain text resources, not prebuilt native binaries. Dependency package
versions can be pinned; the target Debian repositories and CPU architecture must
provide those packages. New generic worker capabilities still require a Cheshi
update, while adding packs and their scripts does not.

## Validation

```sh
bun test desktop/test/homie-packs.test.ts desktop/test/agent-package-ipc.test.ts
bun test desktop/test/homie-management-tools.test.tsx desktop/test/agent-package-views.test.tsx desktop/test/homie-pack-authoring.test.ts
bun test experiments/codex-specialists/src/pack-tools.test.ts
```

The opt-in Docker test uses `colima-cheshi` and an existing `cheshi-specialist:1`
image. It installs `jq`, executes an isolated script and checks skill installation
and read-only assets. It attaches no project or account volumes and removes its
test container and derived image afterward:

```sh
CHESHI_TEST_HOMIE_PACK_DOCKER=1 bun test desktop/test/homie-pack-docker.test.ts
```

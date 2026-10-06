# Portable Homie packages

In **Homies → New agent → Agent package**, select an official package or import
an `agent.json` file. Preview the instructions, default model, tools and requested
permissions, then load it into the draft. Select your local account and review
project permissions before saving. Start the worker through the existing controls.

Cheshi includes `cheshi-development` and `cheshi-review`, both version `1.0.0`.
Copy either directory to another PC to import it. Each contains exactly the two
required files: `agent.json` and `instructions.md`. No installation scripts run.

The manifest uses schema version 1:

```json
{
  "schemaVersion": 1,
  "id": "example.development",
  "version": "1.0.0",
  "name": "Example Development Specialist",
  "description": "Implement and verify approved changes.",
  "role": "development",
  "instructionsFile": "instructions.md",
  "model": { "model": null, "reasoningEffort": null, "serviceTier": null },
  "requiredTools": ["codegraph", "collaboration", "verification"],
  "requestedPermissions": { "fileWrite": true, "commandExecution": true }
}
```

- IDs use lowercase letters, numbers, dots and hyphens. Versions use three
  numeric components. Unknown schema versions, fields and tools are rejected.
- Roles use the existing specialist roles. Null model settings select runtime
  defaults; an explicit model must be available for the selected local account.
- Supported required tools are `codegraph`, `collaboration` and `verification`.
  The worker supplies the collaboration and verification protocols. CodeGraph
  connection availability is checked at Start; normal query readiness and index
  synchronization remain managed by Cheshi.
- Permission requests fill the creation form only. They do not start a worker or
  override the user's selected project permissions. File and command tools remain
  governed by those permissions and the existing runtime sandbox.
- Both files must be regular UTF-8 files within the selected package directory,
  each at most 256 KiB. Instructions share the existing form's 20,000-character
  limit. Invalid or oversized input is rejected, never silently truncated.

The saved Homie contains a complete package snapshot, including its ID, version
and original instructions. It does not depend on the imported directory afterward.
Project instructions, linked Markdown rules, accounts, paths, credentials and
sessions remain local and are not included in the package. Project `AGENTS.md`
and applicable directory rules still apply through the normal worker workflow.

To update an installed package, import the same package ID in its agent settings.
Review the current and incoming instructions before applying the draft. Customized
instructions are kept by default; turn off **Keep current instructions** to replace
them. The existing name, role, account, model, linked files, project settings and
permissions are preserved. Save explicitly; new worker instructions apply at the
next Start, not in the middle of a running task. Updates are manual and there is no
remote version check, signature verification or automatic merge in this version.

Session transfer and GitHub distribution are separate from this package format.

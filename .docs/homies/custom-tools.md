# External tools for Homies

Author tools outside the Cheshi repository. Cheshi imports their definitions and
scripts, registers them with the selected Homie, and executes calls through its
common runner. Adding a provider requires no Cheshi source change.

In **Homie settings → Tools → Custom tools**, choose **Import tool folder…**.
The folder contains `tool.json` and its files:

```text
my-tool/
  tool.json
  scripts/
    run.ts
```

`tool.json`:

```json
{
  "schemaVersion": 1,
  "tool": {
    "name": "check_content",
    "description": "Evaluate content using the connected service.",
    "enabled": true,
    "runtime": "bun",
    "script": "scripts/run.ts",
    "parameters": [
      { "name": "content", "type": "string", "description": "Content to evaluate", "required": true }
    ],
    "network": { "url": "https://api.example.com/check", "credential": "content_service" }
  },
  "programs": []
}
```

Replace the endpoint with your service. `scripts/run.ts` reads input JSON from
stdin and writes exactly one JSON envelope to stdout:

```ts
const input = JSON.parse(await Bun.stdin.text());
console.log(JSON.stringify({ request: { body: { content: input.content } } }));
```

The common broker posts `body` to the configured endpoint and returns its JSON
response to the Homie. Alternatively, a script can return `{ "result": ... }`
without making a network request. Tools appear to the model as `homie_<name>`.

Supported runtimes are Bun, Node and Python 3. Python requires `python3` in
`programs`. Input fields support string, number and boolean. Programs use Debian
package names. Files may be under `scripts/`, `resources/` or `skills/`; each
skill needs its `SKILL.md`. Duplicate tool names and file paths are rejected
without overwriting the existing pack.

A single JSON bundle can also be imported with **Import tool file…**. Use
`{ "schemaVersion": 1, "tool": ..., "resources": { "programs": [], "files":
[{ "path": "scripts/run.ts", "content": "..." }] } }`.
Exporting the Homie pack includes all imported definitions, scripts and program
requirements. It excludes API keys, accounts and project assignments.

Enter the tool's API key in its settings on each computer. Keys are encrypted
with the operating system credential storage and scoped to an HTTPS origin and
credential name. No provider receives another origin's key, and no provider has
special built-in credential fallback. The current broker supports public HTTPS
POST endpoints with JSON responses and optional Bearer authentication. It does
not support MCP, OAuth, streaming, redirects or multiple network requests per
script call.

Save the Homie and start its worker to prepare the pack image. New tools require
a new conversation. The saved tool can also be invoked with **Run test**; an
external API test sends the entered inputs to that endpoint.

Scripts run in separate read-only, network-isolated containers with no project,
account or session mounts. Command permission is required. Images are prepared
when starting the Homie and reused for calls. Calls have a 60-second deadline;
script processes have the Docker command runner's 30-second timeout. Inputs and
request bodies are limited to 64 KiB, API responses to 1 MiB. Completed and
interrupted request receipts prevent automatic replay after a host restart
within the request deadline. Canceling an external call cannot undo effects
already accepted by the service; uncertain calls must not be retried blindly.

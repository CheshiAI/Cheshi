# Managed local services for Homie tools

A host tool can declare a service dependency in its portable tool definition:

```json
{
  "service": {
    "name": "local_server",
    "script": "scripts/service.py",
    "when": {
      "parameter": "request",
      "jsonField": "action",
      "values": ["begin", "connect"]
    }
  }
}
```

The optional `when` condition matches a literal string in a JSON-string tool
parameter. Without it, every invocation prepares the service. Cleanup actions
should normally omit the dependency. Both entry scripts must be included in the
reviewed package. Service declarations on container tools are rejected. Tools
sharing a service name must declare the same script and runtime.

Cheshi uses the tool's approved executable and a retained copy of the reviewed
package. It starts the service supervisor directly, without a shell, under a
separate owned process group. The normal one-shot tool and its cleanup remain
unchanged. No special handling of Appium or any other vendor lives in Cheshi.

The supervisor receives newline-delimited JSON on stdin:

```json
{"action":"ensure","inputs":{"request":"{\"action\":\"begin\"}"}}
```

It must return exactly one bounded JSON line per request: `{"ok":true}`, or
`{"ok":false,"error":{"code":"setup_required","message":"Prepare the runtime."}}`.
Only literal `true` permits the device/tool script to run. The supervisor remains
alive and rechecks readiness for subsequent calls. Inputs are the already validated
tool arguments, not permission to execute arbitrary commands. Startup or protocol
failures do not replay a device operation. Responses are limited to 16 KiB and each
readiness transaction has a 25-second deadline.
Service-dependent worker and tool-test calls reserve 90 seconds for preparation,
the existing 50-second one-shot tool budget, and relay delivery. Calls without a
matching service dependency retain their 60-second limit.

`HOMIE_SERVICE_SOURCE_DIR` identifies the registered local Homie repository for
already installed dependencies and private logs. Its canonical path is bound to
the local grant, shown during review, and checked again before execution. It is
not serialized into the portable manifest. The host environment contains only
the documented runtime environment and this source path, not inherited credentials.

The service key includes project, Homie, account and declared service name.
Concurrent callers share one supervisor and serialize readiness requests. Saved
grants and command permissions are monitored between calls. Revocation, disabled
tools, changed profile revisions, or app shutdown terminate owned process groups;
ordinary completion of a tool call leaves the service available. Existing external
servers must be checked and reused by the supervisor, never adopted or terminated.
Supervisors should also clean up owned children on stdin EOF and SIGTERM. Cheshi
does not install a login daemon or automatically restart a crashed service.

Validation:

```sh
bun test desktop/test/host-tool-services.test.ts desktop/test/host-tools.test.ts
bun run desktop:typecheck
bun run codegraph:server:typecheck
```

The package allowlist must include `host-tool-services.mts`. Native Node imports
and `desktop/test/config-runtime.test.ts` cover the strip-only runtime and packaged
dependency boundary. A successful service readiness check does not establish
device connectivity or screenshot success.

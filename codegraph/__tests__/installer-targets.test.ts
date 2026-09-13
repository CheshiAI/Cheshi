import { registerInstallerCursorRulesFileCleanupOnUninstallTests } from './installer-targets.installer-cursor-rules-file-cleanup-on-uninstall.cases';
import { registerInstallerRefreshtargetsSweepCodegraphInstallRefreshTests } from './installer-targets.installer-refreshtargets-sweep-codegraph-install-refresh.cases';
import { registerInstallerTargetsContractTests } from './installer-targets.installer-targets-contract.cases';
import { registerInstallerTargetsOpencodeXdgConfigPath535Tests } from './installer-targets.installer-targets-opencode-xdg-config-path-535.cases';
import { registerInstallerTargetsPartialStateIdempotencyTests } from './installer-targets.installer-targets-partial-state-idempotency.cases';
import { registerInstallerTargetsRegistryTests } from './installer-targets.installer-targets-registry.cases';
import { registerInstallerTargetsTomlSerializerCodexBackboneTests } from './installer-targets.installer-targets-toml-serializer-codex-backbone.cases';
import { registerInstallerUninstalltargetsSweepCodegraphUninstallTests } from './installer-targets.installer-uninstalltargets-sweep-codegraph-uninstall.cases';
/**
 * Multi-target installer tests.
 *
 * Each `AgentTarget` is exercised against the same contract:
 *   - `install` writes the expected files
 *   - re-running `install` is byte-identical (idempotent)
 *   - sibling MCP servers / unrelated config is preserved
 *   - `uninstall` reverses `install`
 *   - `printConfig` returns parseable, non-empty content
 *
 * For agent-config destinations we redirect HOME to a tmpdir via
 * `os.homedir` spying, and CWD via `process.chdir` — same pattern as
 * the legacy `installer.test.ts`. No real `~/.claude/` etc. ever
 * touched.
 */


registerInstallerTargetsContractTests();

registerInstallerTargetsPartialStateIdempotencyTests();

registerInstallerTargetsRegistryTests();

registerInstallerTargetsTomlSerializerCodexBackboneTests();

registerInstallerUninstalltargetsSweepCodegraphUninstallTests();

registerInstallerRefreshtargetsSweepCodegraphInstallRefreshTests();

registerInstallerCursorRulesFileCleanupOnUninstallTests();

registerInstallerTargetsOpencodeXdgConfigPath535Tests();

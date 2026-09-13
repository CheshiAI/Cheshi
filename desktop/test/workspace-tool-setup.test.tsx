import { expect, test } from 'bun:test';
import { Children, isValidElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { WorkspaceToolStatus } from '../shared/workspace-management';
import { WorkspaceToolSetupView, workspaceToolInstallSteps } from '../frontend/src/features/navigation/workspace-management/WorkspaceToolSetup';

const ready: WorkspaceToolStatus = { platform: 'darwin', brew: true, gh: true, codex: true };
const noAction = () => {};

function render(status: WorkspaceToolStatus | null, checking = false, error: string | null = null, copied: string | null = null) {
  return renderToStaticMarkup(<WorkspaceToolSetupView status={status} checking={checking} error={error}
    copied={copied} onCopy={noAction} onRecheck={noAction} />);
}

test('setup is hidden when both tools exist even without Homebrew, and on other platforms', () => {
  expect(render(ready)).toBe('');
  expect(render({ ...ready, brew: false })).toBe('');
  expect(render({ platform: 'win32', brew: false, gh: false, codex: false })).toBe('');
});

test('each missing tool shows its own installation command without reinstalling the other', () => {
  const gh = workspaceToolInstallSteps({ ...ready, gh: false });
  expect(gh.map((step) => step.command)).toEqual(['brew install gh']);
  const codex = workspaceToolInstallSteps({ ...ready, codex: false });
  expect(codex.map((step) => step.command)).toEqual(['brew install --cask codex']);
  expect(render({ ...ready, gh: false })).not.toContain('brew install --cask codex');
  expect(render({ ...ready, codex: false })).not.toContain('brew install gh');
});

test('fresh macOS puts Homebrew first and preserves the literal installer command for copy', () => {
  const status = { platform: 'darwin', brew: false, gh: false, codex: false };
  const steps = workspaceToolInstallSteps(status);
  expect(steps.map((step) => step.id)).toEqual(['brew', 'gh', 'codex']);
  expect(steps[0]!.command).toBe('/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"');
  const html = render(status);
  expect(html).toContain('paste it into macOS Terminal');
  expect(html).toContain('including the shell setup');
  expect(html).toContain('Copy install homebrew command');
  expect(html).toContain('Check again');
});

test('checking and failed status requests have distinct feedback and a retry action', () => {
  const checking = render(null, true);
  expect(checking).toContain('Checking installed tools');
  expect(checking).toContain('disabled=""');
  expect(checking).not.toContain('brew install');
  const failed = render(null, false, 'Could not check installed tools.');
  expect(failed).toContain('role="alert"');
  expect(failed).toContain('Check again');
  expect(failed).not.toContain('disabled=""');
});

function elements(node: ReactNode): Array<{ props: Record<string, unknown> }> {
  const found: Array<{ props: Record<string, unknown> }> = [];
  Children.forEach(node, (child) => {
    if (!isValidElement<{ children?: ReactNode }>(child)) return;
    found.push({ props: child.props });
    found.push(...elements(child.props.children));
  });
  return found;
}

test('copy passes the selected command and recheck invokes only the status action', () => {
  const commands: string[] = [];
  let checks = 0;
  const view = WorkspaceToolSetupView({ status: { ...ready, gh: false, codex: false }, checking: false,
    error: null, copied: null, onCopy: (step) => commands.push(step.command), onRecheck: () => { checks += 1; } });
  const controls = elements(view).filter((element) => typeof element.props.onClick === 'function');
  for (const control of controls) (control.props.onClick as () => void)();
  expect(commands).toEqual(['brew install gh', 'brew install --cask codex']);
  expect(checks).toBe(1);
  expect(render({ ...ready, gh: false }, false, null, 'gh')).toContain('Command copied.');
});

test('recheck removes only newly installed tools and hides setup when installation is complete', () => {
  expect(workspaceToolInstallSteps({ ...ready, gh: false, codex: false })).toHaveLength(2);
  expect(workspaceToolInstallSteps({ ...ready, codex: false }).map((step) => step.id)).toEqual(['codex']);
  expect(render(ready)).toBe('');
});

test('Oh My Zsh is an optional command only while required tools need setup', () => {
  const missing = { ...ready, gh: false, ohMyZsh: false };
  const steps = workspaceToolInstallSteps(missing);
  expect(steps.map((step) => step.id)).toEqual(['gh', 'oh-my-zsh']);
  expect(steps[1]!.command).toBe('sh -c "$(curl -fsSL https://raw.githubusercontent.com/ohmyzsh/ohmyzsh/master/tools/install.sh)"');
  expect(render(missing)).toContain('Oh My Zsh (Optional)');
  expect(render(missing)).toContain('Cheshi works without it');
  expect(workspaceToolInstallSteps({ ...missing, ohMyZsh: true }).map((step) => step.id)).toEqual(['gh']);
  expect(render({ ...ready, ohMyZsh: false })).toBe('');
  expect(render({ ...ready, brew: false, ohMyZsh: false })).toBe('');
});

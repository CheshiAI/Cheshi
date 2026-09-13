import { Check, Copy, RefreshCw } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import type { WorkspaceManagementApi, WorkspaceToolStatus } from '../../../../../shared/workspace-management';
import { LiquidGlassPanel, NeumorphicButton } from '../../../shared/ui';
import { workspaceError } from './workspace-paths';
import styles from './WorkspaceToolSetup.module.css';

interface InstallStep { id: 'brew' | 'gh' | 'codex' | 'oh-my-zsh'; title: string; command: string; description: string }

export function workspaceToolInstallSteps(status: WorkspaceToolStatus): InstallStep[] {
  if (status.platform !== 'darwin' || (status.gh && status.codex)) return [];
  const steps: InstallStep[] = [];
  if (!status.brew) steps.push({
    id: 'brew', title: 'Install Homebrew',
    command: '/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"',
    description: 'Homebrew installs the tools below. Follow its instructions, including the shell setup shown when installation finishes.',
  });
  if (!status.gh) steps.push({ id: 'gh', title: 'Install GitHub CLI', command: 'brew install gh',
    description: 'GitHub CLI enables browser sign-in and browsing your GitHub repositories.' });
  if (!status.codex) steps.push({ id: 'codex', title: 'Install Codex CLI', command: 'brew install --cask codex',
    description: 'Codex CLI enables AI conversations in your workspace. Sign in with ChatGPT after installation.' });
  if (status.ohMyZsh === false) steps.push({
    id: 'oh-my-zsh', title: 'Oh My Zsh (Optional)',
    command: 'sh -c "$(curl -fsSL https://raw.githubusercontent.com/ohmyzsh/ohmyzsh/master/tools/install.sh)"',
    description: 'Adds prompt themes, Git branch information, and shell plugins. Cheshi works without it. The installer updates your zsh configuration; open a new terminal afterward.',
  });
  return steps;
}

export function WorkspaceToolSetupView({ status, checking, error, copied, onCopy, onRecheck }: {
  status: WorkspaceToolStatus | null;
  checking: boolean;
  error: string | null;
  copied: string | null;
  onCopy: (step: InstallStep) => void;
  onRecheck: () => void;
}) {
  const steps = status ? workspaceToolInstallSteps(status) : [];
  if (!steps.length && !error && !checking) return null;
  return <section className={styles.setup} aria-label="Workspace tool setup" aria-busy={checking}>
    <div className={styles.heading}>
      <h2>Set up your tools</h2>
      <NeumorphicButton raised size="standard" disabled={checking} onClick={onRecheck}>
        <RefreshCw aria-hidden="true" />{checking ? 'Checking…' : 'Check again'}
      </NeumorphicButton>
    </div>
    {checking && !status && <p role="status">Checking installed tools…</p>}
    {steps.length > 0 && <>
      <p>Copy each command you need and paste it into macOS Terminal. Optional tools can be skipped. After installation, return here and choose Check again.</p>
      <ol className={styles.steps}>
        {steps.map((step) => <li key={step.id}>
          <h3>{step.title}</h3>
          <LiquidGlassPanel className={styles.command}>
            <span className={styles.prompt} aria-hidden="true">$</span>
            <code>{step.command}</code>
            <NeumorphicButton raised size="icon" aria-label={`Copy ${step.title.toLowerCase()} command`}
              title={copied === step.id ? 'Copied' : 'Copy command'} onClick={() => onCopy(step)}>
              {copied === step.id ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}
            </NeumorphicButton>
          </LiquidGlassPanel>
          <p>{step.description}</p>
        </li>)}
      </ol>
    </>}
    {copied && <span className={styles.feedback} role="status">Command copied.</span>}
    {error && <p className={styles.error} role="alert">{error}</p>}
  </section>;
}

export function WorkspaceToolSetup({ api, platform, onReadyChange, onSettledChange }: {
  api: Pick<WorkspaceManagementApi, 'getToolStatus'>; platform: string;
  onReadyChange: (ready: boolean) => void;
  onSettledChange?: (settled: boolean) => void;
}) {
  const [status, setStatus] = useState<WorkspaceToolStatus | null>(null);
  const [checking, setChecking] = useState(platform === 'darwin');
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const [refresh, setRefresh] = useState(0);
  const copyAttempt = useRef(0);
  useEffect(() => {
    if (platform !== 'darwin') return;
    let active = true;
    setChecking(true);
    onReadyChange(false);
    setError(null);
    setCopied(null);
    copyAttempt.current += 1;
    void api.getToolStatus().then((result) => {
      if (!active) return;
      setStatus(result);
      onReadyChange(result.gh === true && result.codex === true);
    })
      .catch((cause: unknown) => { if (active) setError(`Could not check installed tools. ${workspaceError(cause)}`); })
      .finally(() => { if (active) setChecking(false); });
    return () => { active = false; copyAttempt.current += 1; };
  }, [api, platform, refresh, onReadyChange]);
  useEffect(() => { onSettledChange?.(!checking); }, [checking, onSettledChange]);
  if (platform !== 'darwin') return null;
  const copy = async (step: InstallStep): Promise<void> => {
    const attempt = ++copyAttempt.current;
    setCopied(null);
    try {
      await navigator.clipboard.writeText(step.command);
      if (copyAttempt.current === attempt) { setCopied(step.id); setError(null); }
    } catch {
      if (copyAttempt.current === attempt) setError('Could not copy the command. Select the command text and copy it manually.');
    }
  };
  return <WorkspaceToolSetupView status={status} checking={checking} error={error} copied={copied}
    onCopy={(step) => { void copy(step); }} onRecheck={() => setRefresh((value) => value + 1)} />;
}

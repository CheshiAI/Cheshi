import { KeyRound, Link, PanelRight, Save, Settings, Trash2 } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { cheshiDesktop } from '../../cheshiDesktop';
import type { SettingsApi, TypeSafeSettings } from '../../../../shared/settings';
import { LiquidGlassPanel, NeumorphicButton, NeumorphicTextField, TwoTierHeader,
  draggableWindowRegionStyle, nonDraggableWindowRegionStyle } from '../../shared/ui';
import styles from './SettingsView.module.css';
import { useAutopilotMenu } from './useAutopilotMenu';

export function SettingsView({ rightSidebarOpen, onToggleRightSidebar, api = cheshiDesktop?.settings }: {
  rightSidebarOpen: boolean; onToggleRightSidebar(): void; api?: SettingsApi;
}) {
  const [autopilotMenuVisible, setAutopilotMenuVisible, autopilotKeyAvailable] = useAutopilotMenu(api);
  const [state, setState] = useState<TypeSafeSettings | null>(null);
  const [key, setKey] = useState('');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const pending = useRef(false);
  const revision = useRef(0);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    if (!api) return () => { mounted.current = false; };
    let disposed = false;
    const unsubscribe = api.onTypeSafeChanged(value => { revision.current++; if (!disposed) { setState(value); setNotice(null); } });
    const current = revision.current;
    void api.getTypeSafe().then(value => { if (!disposed && current === revision.current) setState(value); })
      .catch(() => { if (!disposed) setError('Could not load TypeSafe API settings.'); });
    return () => { disposed = true; mounted.current = false; unsubscribe(); };
  }, [api]);
  const execute = async (action: 'save' | 'remove' | 'check') => {
    if (!api || pending.current) return;
    pending.current = true; setBusy(true); setError(null); setNotice(null);
    const current = revision.current;
    try {
      if (action === 'check') {
        const connected = await api.checkTypeSafe();
        if (mounted.current && current === revision.current) setNotice(connected ? 'Connection verified.' : 'Could not verify the connection.');
      } else {
        const result = action === 'save' ? await api.saveTypeSafe(key) : await api.removeTypeSafe();
        if (mounted.current) {
          if (current === revision.current) setState(result);
          setKey('');
          setNotice(action === 'save' ? 'API key saved on this computer.'
            : result.source === 'environment' ? 'Saved key removed. The environment key is now active.' : 'Saved API key removed.');
        }
      }
    } catch (cause) {
      // Main-process errors are controlled messages. Never repeat the submitted key in a notice.
      if (mounted.current) setError(cause instanceof Error && !cause.message.includes(key || '\0')
        ? cause.message : 'Could not update TypeSafe API settings.');
    } finally { pending.current = false; if (mounted.current) setBusy(false); }
  };
  return <main className={styles.workspace} aria-label="Settings">
    <TwoTierHeader className={styles.header} style={draggableWindowRegionStyle} primary={<>
      <div className={styles.heading}>
        <NeumorphicButton raised aria-hidden="true" className={`theme-toggle ${styles.titleMark}`} disabled>
          <Settings aria-hidden="true" />
        </NeumorphicButton>
        <h1>Settings</h1>
      </div>
      <NeumorphicButton raised size="icon" style={nonDraggableWindowRegionStyle}
        aria-label={rightSidebarOpen ? 'Close right sidebar' : 'Open right sidebar'}
        aria-pressed={rightSidebarOpen} onClick={onToggleRightSidebar}><PanelRight aria-hidden="true" /></NeumorphicButton>
    </>} />
    <div className={styles.body}>
      <LiquidGlassPanel as="aside" className={styles.sidebar} aria-label="Settings categories">
        <button type="button" className={styles.item} aria-current="page"><KeyRound aria-hidden="true" />TypeSafe API</button>
      </LiquidGlassPanel>
      <section className={styles.detail} aria-labelledby="typesafe-heading">
        <div className={styles.scroll}>
          <form className={styles.form} onSubmit={event => { event.preventDefault(); void execute('save'); }}>
            <div className={styles.titleRow}>
              <h2 id="typesafe-heading">TypeSafe API Key</h2>
              <NeumorphicButton raised className={styles.menuToggle} role="switch"
                disabled={busy || !autopilotKeyAvailable}
                aria-label="Show Autopilot menu" aria-checked={autopilotMenuVisible}
                title={!autopilotKeyAvailable ? 'Register or unlock a TypeSafe API key first' : autopilotMenuVisible ? 'Hide Autopilot menu' : 'Show Autopilot menu'}
                onClick={() => setAutopilotMenuVisible(!autopilotMenuVisible)}><span aria-hidden="true" /></NeumorphicButton>
            </div>
            <div className={styles.summary}>
              <p>Connect your TypeSafe account to use Jev in Autopilot.</p>
              {!api && <p role="status">API settings are available in the Cheshi desktop app.</p>}
              {api && !state && !error && <p role="status">Loading settings…</p>}
              {state && <div className={styles.status}>
                <span>{state.source === 'saved' ? 'Saved on this computer' : state.source === 'environment' ? 'Using environment key' : 'No API key registered'}</span>
                {state.maskedKey && <code>{state.maskedKey}</code>}
              </div>}
            </div>
            <div className={styles.keyRow}>
              <NeumorphicTextField aria-label="TypeSafe API key" type="password" autoComplete="new-password" spellCheck={false}
                value={key} maxLength={4096} disabled={busy || !state?.canSave} placeholder={state?.source === 'saved' ? 'Enter a replacement key' : 'Enter your TypeSafe API key'}
                onChange={event => { setKey(event.target.value); setNotice(null); setError(null); }} />
              <div className={styles.actions}>
                <NeumorphicButton raised type="submit" size="icon" disabled={busy || !state?.canSave || !key.trim()}
                  aria-label={state?.source === 'saved' ? 'Update key' : 'Save key'} title={state?.source === 'saved' ? 'Update key' : 'Save key'}><Save aria-hidden="true" /></NeumorphicButton>
                <NeumorphicButton raised type="button" size="icon" disabled={busy || !state?.maskedKey || !!key.trim()}
                  aria-label="Check connection" title="Check connection" onClick={() => void execute('check')}><Link aria-hidden="true" /></NeumorphicButton>
                <NeumorphicButton raised type="button" size="icon" disabled={busy || state?.source !== 'saved'}
                  aria-label="Delete saved key" title="Delete saved key" onClick={() => void execute('remove')}><Trash2 aria-hidden="true" /></NeumorphicButton>
              </div>
            </div>
            {busy && <p role="status">Working…</p>}
            {(error || state?.error) && <p role="alert">{error || state?.error}</p>}
            {state && !state.canSave && <p role="alert">Secure storage is unavailable. Unlock your system credential store to save a key.</p>}
            {notice && <p role="status">{notice}</p>}
            <p className={styles.help}>
              Your key is encrypted on this computer. A saved key takes priority over an environment key.<br />
              Autopilot usage and connection checks are billed to your TypeSafe account.<br />
              Research also uses your existing Codex login.
            </p>
          </form>
        </div>
      </section>
    </div>
  </main>;
}

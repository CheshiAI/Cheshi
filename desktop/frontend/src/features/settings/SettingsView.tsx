import { Info, Palette, KeyRound, Link, Save, Settings, Trash2 } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { cheshiDesktop } from '../../cheshiDesktop';
import type { SettingsApi, TypeSafeSettings } from '../../../../shared/settings';
import { LiquidGlassPanel, NeumorphicButton, NeumorphicTextField, TwoTierHeader,
  draggableWindowRegionStyle } from '../../shared/ui';
import styles from './SettingsView.module.css';
import { AppearanceSettings } from './AppearanceSettings';
import { AboutSettings } from './AboutSettings';

export function SettingsView({ api = cheshiDesktop?.settings }: { api?: SettingsApi }) {
  const [category, setCategory] = useState<'typesafe' | 'appearance' | 'about'>('typesafe');
  const [state, setState] = useState<TypeSafeSettings | null>(null);
  const [key, setKey] = useState('');
  const [keyBusy, setKeyBusy] = useState(false);
  const [recallBusy, setRecallBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [recallError, setRecallError] = useState<string | null>(null);
  const pending = useRef({ key: false, recall: false });
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
  const receiveReply = (value: TypeSafeSettings, current: number) => {
    if (mounted.current && current === revision.current) {
      revision.current++;
      setState(value);
    }
  };
  const execute = async (action: 'save' | 'remove' | 'check' | 'recall') => {
    const operation = action === 'recall' ? 'recall' : 'key';
    if (!api || pending.current[operation] || (operation === 'recall' && !state)) return;
    pending.current[operation] = true;
    const setBusy = operation === 'recall' ? setRecallBusy : setKeyBusy;
    const setOperationError = operation === 'recall' ? setRecallError : setError;
    setBusy(true); setOperationError(null);
    if (operation === 'key') setNotice(null);
    const current = revision.current;
    try {
      if (action === 'check') {
        const connected = await api.checkTypeSafe();
        if (mounted.current && current === revision.current) setNotice(connected ? 'Connection verified.' : 'Could not verify the connection.');
      } else if (action === 'recall') {
        const result = await api.setHistoryRecallEnabled(state?.historyRecallEnabled !== true);
        receiveReply(result, current);
      } else {
        const result = action === 'save' ? await api.saveTypeSafe(key) : await api.removeTypeSafe();
        if (mounted.current) {
          receiveReply(result, current);
          setKey('');
          setNotice(action === 'save' ? 'API key saved on this computer.'
            : result.source === 'environment' ? 'Saved key removed. The environment key is now active.' : 'Saved API key removed.');
        }
      }
    } catch (cause) {
      // Main-process errors are controlled messages. Never repeat the submitted key in a notice.
      if (mounted.current) setOperationError(cause instanceof Error && !cause.message.includes(key || '\0')
        ? cause.message : 'Could not update TypeSafe API settings.');
    } finally { pending.current[operation] = false; if (mounted.current) setBusy(false); }
  };
  return <main className={styles.workspace} aria-label="Settings">
    <TwoTierHeader className={styles.header} style={draggableWindowRegionStyle} primary={<>
      <div className={styles.heading}>
        <NeumorphicButton raised size="icon" aria-hidden="true" className={styles.titleMark} disabled>
          <Settings aria-hidden="true" />
        </NeumorphicButton>
        <h1 className={styles.sectionTitle}>SETTINGS</h1>
      </div>
    </>} />
    <div className={styles.body}>
      <LiquidGlassPanel as="aside" className={styles.sidebar} aria-label="Settings categories">
        <button type="button" className={styles.item} aria-current={category === 'typesafe' ? 'page' : undefined} onClick={() => setCategory('typesafe')}><KeyRound aria-hidden="true" />TypeSafe API</button>
        <button type="button" className={styles.item} aria-current={category === 'appearance' ? 'page' : undefined} onClick={() => setCategory('appearance')}><Palette aria-hidden="true" />Appearance</button>
        <button type="button" className={styles.item} aria-current={category === 'about' ? 'page' : undefined} onClick={() => setCategory('about')}><Info aria-hidden="true" />About</button>
      </LiquidGlassPanel>
      {category === 'about' ? <AboutSettings /> : category === 'appearance' ? <AppearanceSettings /> : <section className={styles.detail} aria-labelledby="typesafe-heading">
        <div className={styles.scroll}>
          <form className={styles.form} onSubmit={event => { event.preventDefault(); void execute('save'); }}>
            <div className={styles.titleRow}>
              <h2 id="typesafe-heading" className={styles.sectionTitle}>TypeSafe API Key</h2>
            </div>
            <div className={`${styles.description} ${styles.descriptionGroup}`}>
              <p>Use Jev to find previous conversations and make yes/no decisions in executable skills. Saving a key does not enable history recall.</p>
              {!api && <p role="status" className={styles.description}>API settings are available in the Cheshi desktop app.</p>}
              {api && !state && !error && <p role="status" className={styles.description}>Loading settings…</p>}
              {state && <div className={styles.status}>
                <span>{state.source === 'saved' ? 'Saved on this computer' : state.source === 'environment' ? 'Using environment key' : 'No API key registered'}</span>
                {state.maskedKey && <code>{state.maskedKey}</code>}
              </div>}
            </div>
            <div className={styles.keyRow}>
              <NeumorphicTextField variant="standard" aria-label="TypeSafe API key" type="password" autoComplete="new-password" spellCheck={false}
                value={key} maxLength={4096} disabled={keyBusy || !state?.canSave} placeholder={state?.source === 'saved' ? 'Enter a replacement key' : 'Enter your TypeSafe API key'}
                onChange={event => { setKey(event.target.value); setNotice(null); setError(null); }} />
              <div className={styles.actions}>
                <NeumorphicButton className={styles.circleButton} raised type="submit" size="icon" disabled={keyBusy || !state?.canSave || !key.trim()}
                  aria-label={state?.source === 'saved' ? 'Update key' : 'Save key'} title={state?.source === 'saved' ? 'Update key' : 'Save key'}><Save aria-hidden="true" /></NeumorphicButton>
                <NeumorphicButton className={styles.circleButton} raised type="button" size="icon" disabled={keyBusy || !state?.maskedKey || !!key.trim()}
                  aria-label="Check connection" title="Check connection" onClick={() => void execute('check')}><Link aria-hidden="true" /></NeumorphicButton>
                <NeumorphicButton className={styles.circleButton} raised type="button" size="icon" disabled={keyBusy || state?.source !== 'saved'}
                  aria-label="Delete saved key" title="Delete saved key" onClick={() => void execute('remove')}><Trash2 aria-hidden="true" /></NeumorphicButton>
              </div>
            </div>
            {keyBusy && <p role="status" className={styles.description}>Working…</p>}
            {(error || state?.error) && <p role="alert" className={styles.description}>{error || state?.error}</p>}
            {state && !state.canSave && <p role="alert" className={styles.description}>Secure storage is unavailable. Unlock your system credential store to save a key.</p>}
            {notice && <p role="status" className={styles.description}>{notice}</p>}
            <p className={styles.description}>
              Your key is encrypted on this computer. A saved key takes priority over an environment key.<br />
              Jev requests and connection checks use your TypeSafe account allowance.<br />
              Connection checks send only fixed sample text.
            </p>
            <div className={styles.titleRow}>
              <h3 id="history-recall-heading" className={styles.settingLabel}>Previous conversation recall</h3>
              <NeumorphicButton className={styles.toggle} role="switch" type="button"
                disabled={recallBusy || !api || !state} aria-label="Allow history recall"
                aria-describedby="history-recall-disclosure" aria-checked={state?.historyRecallEnabled === true}
                onClick={() => { void execute('recall'); }}><span aria-hidden="true" /></NeumorphicButton>
            </div>
            {recallBusy && <p role="status" className={styles.description}>Saving history recall setting…</p>}
            {recallError && <p role="alert" className={styles.description}>{recallError}</p>}
            <p id="history-recall-disclosure" className={styles.description}>
              Off by default. This setting applies to all workspaces, including ones opened later.
              Each search stays within the workspace where it is requested.
              Your search question, candidate conversation passages, titles and nearby messages are sent to TypeSafe (Jev).
              If Jev is unavailable or no key is configured, the same search material is sent to OpenAI using Luna low
              with your Codex login. Retrieved originals are also returned to the assistant.<br />
              Turning this off cancels pending recall in all workspaces and blocks further recall calls through both providers.
              Text already sent cannot be recalled. Reopen the workspace after enabling to make the tools available.
              Local history browsing is unaffected.
            </p>
            <div className={styles.titleRow}>
              <h3 className={styles.sectionTitle}>Executable skills</h3>
            </div>
            <p className={styles.description}>
              Skills send their supplied judgment inputs to Jev and use Luna low with your Codex login if Jev is unavailable.
              They run only when invoked and are separate from the history recall switch.
              The executable skill runner is currently available through the source checkout CLI.
            </p>
          </form>
        </div>
      </section>}
    </div>
  </main>;
}

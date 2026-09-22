import { cheshiDesktop } from '../../cheshiDesktop';
import { DEFAULT_WINDOW_APPEARANCE, type WindowAppearanceApi } from '../../../../shared/window-appearance';
import { useAppearanceSettings } from './useAppearanceSettings';
import { NeumorphicButton } from '../../shared/ui';
import styles from './SettingsView.module.css';
import appearance from './AppearanceSettings.module.css';

export function AppearanceSettings({ api = cheshiDesktop?.appearance }: { api?: WindowAppearanceApi }) {
  const { state, draft, error, busy, update, flush } = useAppearanceSettings(api);
  return <section className={styles.detail} aria-labelledby="appearance-heading">
    <div className={styles.scroll}>
      <div className={`${styles.form} ${appearance.form}`}>
        <div className={styles.titleRow}>
          <h2 id="appearance-heading" className={styles.sectionTitle}>Window</h2>
          {draft && <NeumorphicButton className={appearance.resetButton} size="standard" raised disabled={!state?.supported}
            onClick={() => update({ ...DEFAULT_WINDOW_APPEARANCE }, true)}>Reset to default</NeumorphicButton>}
        </div>
        <p className={styles.description}>Let the desktop show through your workspace with a blurred background.</p>
        {!api && <p role="status" className={styles.description}>Appearance settings are available in the Cheshi desktop app.</p>}
        {state && !state.supported && <p role="status" className={styles.description}>Native transparency is unavailable on this system.</p>}
        {draft && <>
          <div className={appearance.row}><span id="window-transparency-label" className={styles.settingLabel}>Window transparency</span>
            <NeumorphicButton className={styles.toggle} role="switch" aria-labelledby="window-transparency-label"
              aria-checked={draft.enabled} disabled={!state?.supported}
              onClick={() => update({ ...draft, enabled: !draft.enabled }, true)}><span /></NeumorphicButton></div>
          <div className={appearance.row}><span id="main-pane-transparency-label" className={styles.settingLabel}>Main pane transparency</span>
            <NeumorphicButton className={styles.toggle} role="switch" aria-labelledby="main-pane-transparency-label"
              aria-checked={draft.mainPaneGlass} disabled={!state?.supported || !draft.enabled}
              onClick={() => update({ ...draft, mainPaneGlass: !draft.mainPaneGlass }, true)}><span /></NeumorphicButton></div>
          <label className={appearance.row}><span className={styles.settingLabel}>Window Opacity: {Math.round(draft.opacity * 100)}</span>
            <input className={appearance.slider} aria-label="Window Opacity" aria-valuetext={`${Math.round(draft.opacity * 100)}%`}
              type="range" min="15" max="100" step="1" value={Math.round(draft.opacity * 100)}
              disabled={!state?.supported || !draft.enabled}
              onChange={event => update({ ...draft, opacity: Number(event.target.value) / 100 })}
              onPointerUp={() => { void flush(); }} onKeyUp={() => { void flush(); }} /></label>
          <label className={appearance.row}><span className={styles.settingLabel}>Window Blur Radius: {draft.blurRadius}</span>
            <input className={appearance.slider} aria-label="Window Blur Radius" type="range" min="0" max="64" step="1" value={draft.blurRadius}
              disabled={!state?.supported || !draft.enabled}
              onChange={event => update({ ...draft, blurRadius: Number(event.target.value) })}
              onPointerUp={() => { void flush(); }} onKeyUp={() => { void flush(); }} /></label>
        </>}
        {(error || state?.error) && <p role="alert">{error || state?.error}</p>}
        <div className={appearance.helpLines}>
          {draft && <p role="status" className={styles.description}>{busy ? 'Saving…' : 'Changes apply automatically.'}</p>}
          <p className={styles.description}>Transparency applies to dark workspaces. macOS Reduce Transparency keeps the window opaque.</p>
        </div>
      </div>
    </div>
  </section>;
}

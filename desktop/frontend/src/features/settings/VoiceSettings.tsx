import { useEffect, useRef, useState } from 'react';
import { cheshiDesktop } from '../../cheshiDesktop';
import type { VoiceRecordingsApi } from '../../../../shared/voice-recordings';
import { NeumorphicButton } from '../../shared/ui';
import styles from './SettingsView.module.css';

export function VoiceSettings({ api = cheshiDesktop?.voiceRecordings, platform = cheshiDesktop?.platform }: {
  api?: VoiceRecordingsApi; platform?: string;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  const pending = useRef(false);
  const mounted = useRef(false);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const openSettings = async () => {
    if (platform !== 'darwin' || !api?.openFullDiskAccessSettings || pending.current) return;
    pending.current = true;
    setBusy(true);
    setError(false);
    try {
      const opened = await api.openFullDiskAccessSettings();
      if (mounted.current) setError(opened !== true);
    } catch { if (mounted.current) setError(true); }
    finally { pending.current = false; if (mounted.current) setBusy(false); }
  };
  return <section className={styles.detail} aria-labelledby="voice-settings-heading">
    <div className={styles.scroll}><div className={styles.form}>
      <div className={styles.titleRow}><h2 id="voice-settings-heading" className={styles.sectionTitle}>Voice Memos</h2></div>
      <p className={styles.description}>Allow Cheshi to read your macOS Voice Memos and display them in Recordings.</p>
      <div className={styles.settingRow}>
        <span className={styles.settingLabel}>Full Disk Access</span>
        <NeumorphicButton variant="standard" aria-label="Open Full Disk Access settings"
          disabled={busy || platform !== 'darwin' || !api?.openFullDiskAccessSettings}
          onClick={() => { void openSettings(); }}>{busy ? 'Opening…' : 'Open System Settings'}</NeumorphicButton>
      </div>
      <p className={styles.description}>In Privacy &amp; Security → Full Disk Access, add the Cheshi app you are using and turn access on.
        Restart Cheshi if prompted, then return to Voice and refresh Recordings.</p>
      {platform !== 'darwin' && <p className={styles.description} role="status">Available in the Cheshi macOS app.</p>}
      {error && <p className={styles.description} role="alert">Could not open System Settings. Open Privacy &amp; Security → Full Disk Access manually, or try again.</p>}
    </div></div>
  </section>;
}

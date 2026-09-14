import { Bell, ExternalLink } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';

import type { AppUpdateApi, AppUpdateState } from '../../../../shared/app-update';
import { cheshiDesktop } from '../../cheshiDesktop';
import { LoadingIndicator, LoadingState, Modal, NeumorphicButton } from '../../shared/ui';
import styles from './AppUpdateIndicator.module.css';

const CHANGELOG_EXCERPT_LENGTH = 1_200;

export function AppUpdateIndicator({ api = cheshiDesktop }: { api?: Partial<AppUpdateApi> } = {}) {
  const [state, setState] = useState<AppUpdateState | null>(null);
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const installPending = useRef(false);

  useEffect(() => {
    if (!api?.getAppUpdate || !api.onAppUpdate) return;
    let active = true;
    let receivedEvent = false;
    const unsubscribe = api.onAppUpdate(next => {
      receivedEvent = true;
      if (active) setState(next);
    });
    void api.getAppUpdate().then(snapshot => {
      // A startup snapshot may finish after a newer download or release event.
      if (active && !receivedEvent) setState(snapshot);
    }).catch(() => {});
    return () => { active = false; unsubscribe(); };
  }, [api]);

  const release = state?.release;
  if (!state || !release) return null;

  const busy = pending || state.phase !== 'idle';
  const preview = state.preview === true;
  const unavailableReason = (preview ? null : state.installUnavailableReason
    ?? (!release.asset ? 'This release does not include an installable app.' : null)
  )
    ?? (!api?.installAppUpdate ? 'In-app updates are unavailable in this environment.' : null);
  const notes = release.notes.trim();
  const excerpt = notes.length > CHANGELOG_EXCERPT_LENGTH
    ? `${notes.slice(0, CHANGELOG_EXCERPT_LENGTH).trimEnd()}…`
    : notes;
  const error = actionError ?? state.error;
  const progress = state.phase === 'installing' ? (preview ? 'Preview: installing update…' : 'Installing the update and restarting…')
    : state.phase === 'downloading' ? (preview ? 'Preview: downloading update…' : 'Downloading update…') : 'Preparing update…';
  const close = () => { if (!busy && !installPending.current) setOpen(false); };
  const install = async () => {
    if (busy || unavailableReason || installPending.current || !api?.installAppUpdate) return;
    installPending.current = true;
    setPending(true);
    setActionError(null);
    try {
      await api.installAppUpdate();
    } catch (reason) {
      setActionError(reason instanceof Error ? reason.message : 'Update failed. Please try again.');
    } finally {
      installPending.current = false;
      setPending(false);
    }
  };
  const openRelease = async () => {
    try {
      await api?.openAppRelease?.();
    } catch (reason) {
      setActionError(reason instanceof Error ? reason.message : 'Could not open the release page. Please try again.');
    }
  };

  return <>
    <button type="button" className={styles.indicator} aria-haspopup="dialog" aria-expanded={open}
      title={`v${state.currentVersion} → v${release.version}`} onClick={() => setOpen(true)}>
      {busy ? <LoadingIndicator /> : <Bell aria-hidden="true" />}
      <span className={styles.indicatorLabel} aria-live="polite">{busy ? progress : 'Update available'}</span>
    </button>
    {open && <Modal className={styles.dialog} title="App update"
      titleIcon={<Bell aria-hidden="true" />} closeDisabled={busy} onClose={close}>
      <div className={styles.content}>
        <p className={styles.version}>
          <span aria-label="Current version">v{state.currentVersion}</span> <span aria-hidden="true">→</span> <span aria-label="New version">v{release.version}</span>
        </p>
        <section className={styles.changelog} aria-label="Release notes">
          <h3>Release notes</h3>
          <p>{excerpt || 'No release notes were provided.'}</p>
        </section>
        <button type="button" className={styles.releaseLink} disabled={preview || !api?.openAppRelease} onClick={() => { void openRelease(); }}>
          View full release <ExternalLink aria-hidden="true" />
        </button>
        {preview ? <>
          <p>Preview mode. No files will be downloaded or installed, and the app will not restart.</p>
          <p>Select Update to simulate progress and a retryable error.</p>
        </> : <p>The app will restart and restore your workspace. Running terminal commands will stop and will not restart automatically.</p>}
        {unavailableReason && <p className={styles.notice}>{unavailableReason}</p>}
        {error && <p role="alert">{error}</p>}
        {busy && <LoadingState className={styles.progress} type="processing" label={progress} />}
        <div className={styles.buttons}>
          <NeumorphicButton size="standard" raised disabled={busy} onClick={close}>Cancel</NeumorphicButton>
          <NeumorphicButton size="standard" raised disabled={busy || unavailableReason !== null}
            aria-busy={busy} onClick={() => { void install(); }}>Update</NeumorphicButton>
        </div>
      </div>
    </Modal>}
  </>;
}

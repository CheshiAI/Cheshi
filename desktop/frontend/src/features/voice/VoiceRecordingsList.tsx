import type { VoiceRecordingsSnapshot } from '../../../../shared/voice-recordings';
import { NeumorphicButton } from '../../shared/ui';
import styles from './VoiceRecordingsSidebar.module.css';

const messages = {
  'permission-required': 'Open Settings → Voice to allow access to your macOS Voice Memos.',
  unsupported: 'Apple Voice Memos is available on macOS only.',
  'unsupported-format': 'This version of the Voice Memos library is not supported yet.',
  unavailable: 'Could not load Voice Memos. Try again.',
};
export function recordingDuration(seconds: number | null): string {
  if (seconds === null) return '—';
  const value = Math.floor(seconds);
  const minutes = Math.floor(value / 60);
  return `${minutes}:${String(value % 60).padStart(2, '0')}`;
}
function recordingDate(timestamp: number | null): string {
  if (timestamp === null) return 'Unknown date';
  return new Intl.DateTimeFormat(undefined, { year: 'numeric', month: 'short', day: 'numeric' }).format(timestamp);
}
export function VoiceRecordingsList({ snapshot, loading, refresh, onOpenSettings, selectedId, onSelect }: {
  selectedId: string | null; onSelect(id: string): void;
  snapshot: VoiceRecordingsSnapshot | null; loading: boolean; refresh: () => Promise<void>; onOpenSettings?: () => void;
}) {
  if (!snapshot) return <p className={styles.empty} role="status">Loading recordings…</p>;
  if (snapshot.status !== 'ready') return <div className={styles.notice}>
    <p className={styles.empty} role="status">{messages[snapshot.status]}</p>
    {snapshot.status === 'permission-required' ? <NeumorphicButton variant="ghost" disabled={!onOpenSettings}
      aria-label="Open Voice settings" onClick={onOpenSettings}>Settings</NeumorphicButton>
      : snapshot.status !== 'unsupported' && <NeumorphicButton variant="ghost" disabled={loading}
      onClick={() => { void refresh(); }}>Try again</NeumorphicButton>}
  </div>;
  return <>
    {snapshot.recordings.length === 0 && <p className={styles.empty}>No recordings yet.</p>}
    <ul className={styles.recordings} aria-label="Voice Memo recordings" aria-busy={loading}>
      {snapshot.recordings.map(recording => <li key={recording.id}>
        <button type="button" className={styles.recording} aria-pressed={selectedId === recording.id}
          onClick={() => onSelect(recording.id)}>
        <strong className={styles.recordingTitle} title={recording.title}>{recording.title}</strong>
        <span className={styles.metadata}>
          <time dateTime={recording.recordedAt === null ? undefined : new Date(recording.recordedAt).toISOString()}>
            {recordingDate(recording.recordedAt)}
          </time>
          <span aria-label="Duration">{recordingDuration(recording.durationSeconds)}</span>
        </span>
        </button>
      </li>)}
    </ul>
    {snapshot.truncated && <p className={styles.empty}>Showing the latest {snapshot.recordings.length.toLocaleString()} recordings.</p>}
  </>;
}

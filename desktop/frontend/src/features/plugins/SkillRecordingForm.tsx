import { trackSkillCatalogWorkflow } from '../../shared/skillCatalogChanges';
import { useEffect, useRef, useState } from 'react';

import type { SkillRecordingUpload } from '../../../../shared/plugin-actions';
import { NeumorphicButton, NeumorphicTextField } from '../../shared/ui';
import { pluginDesktop, usePluginAction, type PluginWorkflowFormProps } from './PluginActionForms';
import { startSkillCapture, type SkillCapture } from './skillRecording';
import styles from './PluginActionForms.module.css';

export function SkillRecordingForm({ chatContextId, onBusyChange, onStarted }: PluginWorkflowFormProps) {
  const [description, setDescription] = useState('');
  const [capturing, setCapturing] = useState(false);
  const [picking, setPicking] = useState(false);
  const [seconds, setSeconds] = useState(0);
  const [recording, setRecording] = useState<SkillRecordingUpload | null>(null);
  const [preview, setPreview] = useState('');
  const [captureError, setCaptureError] = useState('');
  const capture = useRef<SkillCapture | null>(null);
  const mounted = useRef(true);
  const savedId = useRef<string | null>(null);
  const { busy, error, run } = usePluginAction(onBusyChange);

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; capture.current?.cancel(); };
  }, []);

  useEffect(() => {
    if (!recording) { setPreview(''); return; }
    const url = URL.createObjectURL(new Blob([new Uint8Array(recording.video)], { type: 'video/webm' }));
    setPreview(url);
    return () => URL.revokeObjectURL(url);
  }, [recording]);

  useEffect(() => {
    if (!capturing) return;
    const start = Date.now();
    const timer = setInterval(() => setSeconds(Math.floor((Date.now() - start) / 1000)), 250);
    return () => clearInterval(timer);
  }, [capturing]);

  const start = async () => {
    if (picking || capture.current) return;
    setPicking(true);
    setCaptureError('');
    try {
      const next = await startSkillCapture();
      capture.current = next;
      if (!mounted.current) next.cancel();
      else {
        setRecording(null);
        savedId.current = null;
        setSeconds(0);
        setCapturing(true);
      }
      try {
        const result = await next.result;
        if (mounted.current) setRecording(result);
      } finally {
        capture.current = null;
      }
    } catch (cause) {
      if (mounted.current) {
        setCaptureError(cause instanceof DOMException && cause.name === 'NotAllowedError'
          ? 'Screen selection was cancelled or permission was denied. Allow Cheshi in macOS Screen Recording settings and try again.'
          : cause instanceof Error ? cause.message : 'Screen recording could not start.');
      }
    } finally {
      if (mounted.current) { setPicking(false); setCapturing(false); }
    }
  };

  return (
    <form className={styles.form} aria-busy={busy} onSubmit={(event) => {
      event.preventDefault();
      if (!recording) return;
      void run(async () => {
        const api = pluginDesktop();
        if (!savedId.current) savedId.current = (await api.saveSkillRecording(recording)).id;
        const result = await api.startPluginWorkflow({ kind: 'skill', description, recordingId: savedId.current }, chatContextId);
        trackSkillCatalogWorkflow(result.threadId);
        onStarted(result.threadId);
      });
    }}>
      <label className={styles.field}>
        Workflow
        <NeumorphicTextField multiline autoFocus required maxLength={16_000} rows={3} value={description} disabled={busy}
          placeholder="Describe the task and the result you want to repeat."
          onChange={(event) => setDescription(event.target.value)} />
      </label>
      <p className={styles.hint}>Record a screen or window for up to 2 minutes, without audio. Review it before creating your skill.</p>
      {capturing && <p className={styles.message} role="status">Recording · {Math.floor(seconds / 60)}:{String(seconds % 60).padStart(2, '0')} / 2:00</p>}
      {preview && <video className={styles.preview} src={preview} controls aria-label="Review recorded workflow" />}
      {recording && <p className={styles.hint}>Your recording is saved locally and sent to a new chat. Codex can edit files and asks before extra access.</p>}
      {(captureError || error) && <p className={styles.error} role="alert">{captureError || error}</p>}
      <div className={styles.actions}>
        {capturing
          ? <NeumorphicButton raised onClick={() => capture.current?.stop()}>Stop recording</NeumorphicButton>
          : <NeumorphicButton raised={!recording} disabled={busy || picking} onClick={() => void start()}>{picking ? 'Choose a screen…' : recording ? 'Record again' : 'Start recording'}</NeumorphicButton>}
        {recording && <NeumorphicButton raised type="submit" disabled={busy || picking || !description.trim()}>{busy ? 'Creating…' : 'Create skill'}</NeumorphicButton>}
      </div>
    </form>
  );
}

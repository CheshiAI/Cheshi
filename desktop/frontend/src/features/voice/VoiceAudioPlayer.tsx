import { useEffect, useId, useState, type RefObject } from 'react';
import { Check, Download, Gauge, Pause, Play, Volume2, VolumeX } from 'lucide-react';
import type { VoiceDetailApi, VoiceWaveform } from '../../../../shared/voice-transcription';
import { LiquidGlassPanel } from '../../shared/ui';
import { TooltipButton } from '../../shared/ui/TooltipButton';
import { ToolbarMenu } from '../../shared/ui/ToolbarMenu';
import { recordingDuration } from './VoiceRecordingsList';
import styles from './VoiceAudioPlayer.module.css';

const speeds = [0.5, 0.75, 1, 1.25, 1.5, 2];
export function VoiceAudioPlayer({ url, api, audioRef, onError, onTimeChange }: {
  url: string; api: VoiceDetailApi; audioRef: RefObject<HTMLAudioElement | null>; onError(): void;
  onTimeChange?(time: number): void;
}) {
  const [waveform, setWaveform] = useState<VoiceWaveform | null>();
  const [duration, setDuration] = useState(0);
  const [time, setTime] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [volume, setVolume] = useState(1);
  const [muted, setMuted] = useState(false);
  const [rate, setRate] = useState(1);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState('');
  const clipId = useId().replaceAll(':', '');
  useEffect(() => {
    let current = true;
    setWaveform(undefined);
    void api.waveform(url).then(value => { if (current) setWaveform(value); })
      .catch(() => { if (current) setWaveform(null); });
    return () => { current = false; };
  }, [api, url]);
  const sync = () => {
    const audio = audioRef.current;
    if (!audio) return;
    setDuration(Number.isFinite(audio.duration) && audio.duration > 0 ? audio.duration : 0);
    setTime(audio.currentTime); setPlaying(!audio.paused && !audio.ended);
    onTimeChange?.(audio.currentTime);
    setVolume(audio.volume); setMuted(audio.muted); setRate(audio.playbackRate);
  };
  const seek = (value: number) => {
    if (audioRef.current && duration > 0) { audioRef.current.currentTime = Math.max(0, Math.min(duration, value)); sync(); }
  };
  const toggle = async () => {
    const audio = audioRef.current;
    if (!audio) return;
    setMessage('');
    if (!audio.paused) audio.pause();
    else {
      try { await audio.play(); }
      catch { setMessage('Could not start playback. Try again.'); }
    }
    sync();
  };
  const save = async () => {
    if (saving) return;
    setSaving(true); setMessage('');
    try {
      const result = await api.saveAudio(url);
      setMessage(result === 'saved' ? 'Recording saved.' : result === 'error' ? 'Could not save the recording. Try again.' : '');
    } catch { setMessage('Could not save the recording. Try again.'); }
    finally { setSaving(false); }
  };
  const progress = duration > 0 ? Math.min(1, Math.max(0, time / duration)) : 0;
  const maximum = Math.max(0.01, ...(waveform?.peaks ?? []));
  const bars = waveform?.peaks.map((peak, index, peaks) => {
    const x = (index + 0.5) * 1024 / peaks.length;
    const height = Math.max(1, Math.sqrt(peak / maximum) * 54);
    return `M${x},${32 - height / 2}v${height}`;
  }).join(' ');
  return <LiquidGlassPanel as="section" className={styles.player} aria-label="Audio player">
    <audio ref={audioRef} className={styles.audio} src={url} preload="metadata" aria-label="Recording playback"
      onError={onError} onLoadedMetadata={sync} onDurationChange={sync} onTimeUpdate={sync} onSeeked={sync}
      onPlay={sync} onPause={sync} onEnded={sync} onVolumeChange={sync} onRateChange={sync} />
    <div className={styles.waveform}>
      <svg viewBox="0 0 1024 64" preserveAspectRatio="none" aria-hidden="true">
        <defs><clipPath id={clipId}><rect width={progress * 1024} height="64" /></clipPath></defs>
        {bars ? <><path className={styles.bars} d={bars} /><path className={styles.playedBars} d={bars} clipPath={`url(#${clipId})`} /></>
          : <path className={styles.bars} d="M0,32H1024" />}
      </svg>
      <span className={styles.playhead} style={{ left: `${progress * 100}%` }} />
      <input className={styles.seek} type="range" min="0" max={duration || 1} step="0.1" value={Math.min(time, duration)}
        disabled={!duration} aria-label="Seek recording" aria-valuetext={`${recordingDuration(time)} of ${recordingDuration(duration)}`}
        onInput={event => seek(Number(event.currentTarget.value))} />
    </div>
    <div className={styles.controls}>
      <TooltipButton variant="standard" size="icon" aria-label={playing ? 'Pause recording' : 'Play recording'}
        title={playing ? 'Pause' : 'Play'} disabled={!duration} onClick={() => { void toggle(); }}>
        {playing ? <Pause aria-hidden="true" /> : <Play aria-hidden="true" />}
      </TooltipButton>
      <span className={styles.time}>{recordingDuration(time)} / {recordingDuration(duration)}</span>
      <span className={styles.spacer} />
      <span className={styles.rate} aria-label="Playback speed">{rate}×</span>
      <TooltipButton variant="ghost" size="icon" aria-label={muted ? 'Unmute recording' : 'Mute recording'}
        title={muted ? 'Unmute' : 'Mute'} onClick={() => { if (audioRef.current) { audioRef.current.muted = !muted; sync(); } }}>
        {muted || !volume ? <VolumeX aria-hidden="true" /> : <Volume2 aria-hidden="true" />}
      </TooltipButton>
      <input className={styles.volume} type="range" min="0" max="1" step="0.01" value={muted ? 0 : volume}
        aria-label="Recording volume" onInput={event => {
          if (audioRef.current) { audioRef.current.volume = Number(event.currentTarget.value); audioRef.current.muted = false; sync(); }
        }} />
      <ToolbarMenu label="Recording options" items={[
        { id: 'download', label: saving ? 'Saving…' : 'Download', icon: <Download aria-hidden="true" />, disabled: saving,
          onSelect: () => { void save(); } },
        { id: 'speed', label: 'Playback speed', icon: <Gauge aria-hidden="true" />, shortcut: `${rate}×`, children:
          speeds.map(speed => ({ id: String(speed), label: `${speed}×${speed === 1 ? ' (Normal)' : ''}`,
            icon: speed === rate ? <Check aria-hidden="true" /> : <Gauge aria-hidden="true" />,
            onSelect: () => { if (audioRef.current) { audioRef.current.playbackRate = speed; sync(); } } })) },
      ]} />
    </div>
    {(message || !waveform) && <p className={styles.status} role="status">{message ||
      (waveform === undefined ? 'Loading waveform…' : 'Waveform unavailable. Playback and seeking are still available.')}</p>}
  </LiquidGlassPanel>;
}

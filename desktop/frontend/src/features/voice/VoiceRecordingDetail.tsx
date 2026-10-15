import { useEffect, useRef, useState } from 'react';
import type { VoiceRecording } from '../../../../shared/voice-recordings';
import type { VoiceCapabilities, VoiceDetailApi, VoiceTranscription } from '../../../../shared/voice-transcription';
import { LiquidGlassPanel, LiquidGlassSelect, NeumorphicButton } from '../../shared/ui';
import { useAutoHideScrollbars } from '../../shared/useAutoHideScrollbars';
import { recordingDuration } from './VoiceRecordingsList';
import styles from './VoiceRecordingDetail.module.css';
import { VoiceAudioPlayer } from './VoiceAudioPlayer';

const englishLanguageNames = new Intl.DisplayNames(['en'], { type: 'language', languageDisplay: 'standard' });
const englishRegionNames = new Intl.DisplayNames(['en'], { type: 'region' });
function languageLabel(id: string): string {
  try {
    const locale = new Intl.Locale(id.replaceAll('_', '-'));
    const language = englishLanguageNames.of([locale.language, locale.script].filter(Boolean).join('-')) ?? locale.language;
    return locale.region ? `${language} (${englishRegionNames.of(locale.region) ?? locale.region})` : language;
  }
  catch { return id; }
}

const progressText = {
  preparing: 'Preparing on-device transcription…', downloading: 'Downloading the Apple speech model…',
  transcribing: 'Transcribing on this Mac…', complete: 'Transcription complete.', cancelled: 'Transcription cancelled.',
  error: 'Could not transcribe this recording. Check the audio file and speech model, then try again.',
};
const errorText: Record<string, string> = {
  'unsupported-language': 'This language is not supported by Apple speech recognition on this Mac.',
  'model-unavailable': 'Could not prepare the speech model. Check your internet connection and available storage, then try again.',
  'audio-unavailable': 'Download the original audio in Voice Memos and check Settings → Voice, then try again.',
};
export function VoiceRecordingDetail({ recording, api }: { recording: VoiceRecording; api?: VoiceDetailApi }) {
  const scrollRef = useAutoHideScrollbars<HTMLDivElement>();
  const audioRef = useRef<HTMLAudioElement>(null);
  const activeRequest = useRef<string | null>(null);
  const mounted = useRef(false);
  const [url, setUrl] = useState<string>();
  const [audioError, setAudioError] = useState(false);
  const [playbackTime, setPlaybackTime] = useState<number | null>(null);
  const [retry, setRetry] = useState(0);
  const [capabilities, setCapabilities] = useState<VoiceCapabilities>();
  const [capabilityError, setCapabilityError] = useState(false);
  const [locale, setLocale] = useState('');
  const [transcript, setTranscript] = useState<VoiceTranscription>();
  const [requestId, setRequestId] = useState<string | null>(null);
  const busy = transcript && ['preparing', 'downloading', 'transcribing'].includes(transcript.status);
  const activeSegment = url && !audioError && playbackTime !== null
    ? transcript?.segments.findIndex(segment => segment.start <= playbackTime && playbackTime < segment.end) ?? -1 : -1;

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      if (activeRequest.current) void api?.cancelTranscription(activeRequest.current).catch(() => {});
      activeRequest.current = null;
    };
  }, [api]);
  useEffect(() => {
    let current = true, opened: string | undefined;
    setUrl(undefined); setAudioError(false); setPlaybackTime(null);
    if (!api) { setAudioError(true); return; }
    void api.openAudio(recording.id).then(value => {
      if (current) { opened = value; setUrl(value); }
      else void api.releaseAudio(value).catch(() => {});
    }).catch(() => { if (current) setAudioError(true); });
    return () => {
      current = false;
      if (opened) void api.releaseAudio(opened).catch(() => {});
    };
  }, [api, recording.id, retry]);
  useEffect(() => {
    let current = true;
    setCapabilities(undefined); setCapabilityError(false);
    if (!api) { setCapabilityError(true); return; }
    void api.capabilities().then(value => {
      if (!current) return;
      setCapabilities(value);
      const language = window.navigator.language.replace('_', '-');
      const match = value.languages.find(item => item.id.replace('_', '-') === language)
        ?? value.languages.find(item => item.id.split(/[-_]/)[0] === language.split('-')[0]);
      setLocale(match?.id ?? '');
    }).catch(() => { if (current) setCapabilityError(true); });
    return () => { current = false; };
  }, [api, retry]);
  useEffect(() => {
    if (!api || !requestId) return;
    let current = true;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const state = await api.transcription(requestId);
        if (!current || activeRequest.current !== requestId) return;
        setTranscript(state);
        if (['preparing', 'downloading', 'transcribing'].includes(state.status)) timer = setTimeout(() => { void poll(); }, 600);
        else { activeRequest.current = null; setRequestId(null); }
      } catch {
        if (current) {
          void api.cancelTranscription(requestId).catch(() => {});
          activeRequest.current = null; setRequestId(null);
          setTranscript({ status: 'error', segments: [] });
        }
      }
    };
    void poll();
    return () => { current = false; clearTimeout(timer); };
  }, [api, requestId]);
  const transcribe = async () => {
    if (!api || !locale || activeRequest.current) return;
    const id = crypto.randomUUID();
    activeRequest.current = id;
    setTranscript({ status: 'preparing', segments: [] });
    try {
      await api.transcribe(recording.id, locale, id);
      if (mounted.current && activeRequest.current === id) setRequestId(id);
      else void api.cancelTranscription(id).catch(() => {});
    } catch {
      if (mounted.current && activeRequest.current === id) {
        activeRequest.current = null; setTranscript({ status: 'error', segments: [] });
      }
    }
  };
  const cancel = () => {
    const id = activeRequest.current;
    activeRequest.current = null; setRequestId(null);
    setTranscript({ status: 'cancelled', segments: [] });
    if (id) void api?.cancelTranscription(id).catch(() => {});
  };
  return <div ref={scrollRef} className={styles.detail}>
    <h3 className={styles.title}>{recording.title}</h3>
    <p className={styles.description}>{recording.recordedAt === null ? 'Unknown date' : new Date(recording.recordedAt).toLocaleString()}
      {' · '}{recordingDuration(recording.durationSeconds)}</p>
    {url && !audioError && api && <VoiceAudioPlayer key={url} url={url} api={api} audioRef={audioRef}
      onTimeChange={setPlaybackTime} onError={() => setAudioError(true)} />}
    {!url && !audioError && <p className={styles.description} role="status">Loading audio…</p>}
    {audioError && <p className={styles.description} role="alert">Could not load audio. Download the recording in Voice Memos and check Settings → Voice.</p>}
    {(audioError || capabilityError) && <NeumorphicButton variant="ghost" disabled={!!busy} aria-label="Retry recording"
      onClick={() => setRetry(value => value + 1)}>Try again</NeumorphicButton>}
    <div className={styles.actions}>
      <h4 className={styles.sectionTitle}>TRANSCRIPT</h4>
      {!!capabilities?.languages.length && <>
        <LiquidGlassSelect className={styles.languageSelect} ariaLabel="Transcription language" value={locale} onChange={setLocale}
          placeholder="Choose language" disabled={!!busy} menuAppearance="toolbar" triggerAppearance="standard"
          menuWidth={240} menuMaxHeight={280}
          options={capabilities.languages.map(language => ({ value: language.id, label: languageLabel(language.id) }))} />
        <NeumorphicButton variant="standard" aria-label="Transcribe recording" disabled={!!busy || !url || audioError || !locale}
          onClick={() => { void transcribe(); }}>Transcribe</NeumorphicButton>
        {busy && <NeumorphicButton variant="ghost" aria-label="Cancel transcription" onClick={cancel}>Cancel</NeumorphicButton>}
      </>}
    </div>
    {!capabilities && !capabilityError && <p className={styles.description} role="status">Checking Apple speech recognition…</p>}
    {capabilityError && <p className={styles.description} role="alert">Could not check Apple speech recognition. Try again.</p>}
    {capabilities && (!capabilities.available || !capabilities.languages.length) &&
      <p className={styles.description}>On-device transcription requires macOS 26 or later and a supported Mac and language.</p>}
    {transcript?.status === 'complete' && !transcript.segments.length && <p className={styles.description}>No speech detected.</p>}
    <div className={styles.transcript} aria-label="Transcription text">
      {transcript?.segments.map((segment, index) => <LiquidGlassPanel as="article" key={`${segment.start}-${index}`}
        className={styles.segment} aria-label={`Transcript at ${recordingDuration(segment.start)}`}
        aria-current={index === activeSegment ? 'true' : undefined}>
        <div className={styles.segmentHeader}>
          <NeumorphicButton variant="ghost" className={styles.timestamp} aria-label={`Seek to ${recordingDuration(segment.start)}`}
            title="Seek to this position" disabled={!url || audioError} onClick={() => {
              if (audioRef.current) { audioRef.current.currentTime = segment.start; setPlaybackTime(segment.start); }
            }}>{recordingDuration(segment.start)}</NeumorphicButton>
        </div>
        <p className={styles.segmentText}>{segment.text}</p>
      </LiquidGlassPanel>)}
    </div>
    {(!!capabilities?.languages.length || transcript) && <footer className={styles.footer} aria-label="Transcription information">
      {!!capabilities?.languages.length &&
        <p className={styles.description}>Audio is transcribed on this Mac. The selected language model may need an initial download.</p>}
      {transcript && <p className={styles.description} role={transcript.status === 'error' ? 'alert' : 'status'}>
        {(transcript.status === 'error' && errorText[transcript.error ?? '']) || progressText[transcript.status]}</p>}
    </footer>}
  </div>;
}

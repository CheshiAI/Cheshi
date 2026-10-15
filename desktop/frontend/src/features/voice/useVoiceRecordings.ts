import { useCallback, useEffect, useRef, useState } from 'react';
import type { VoiceRecordingsApi, VoiceRecordingsSnapshot } from '../../../../shared/voice-recordings';

const unavailable: VoiceRecordingsSnapshot = { status: 'unavailable', recordings: [], truncated: false };
export function useVoiceRecordings(api: VoiceRecordingsApi | undefined) {
  const [snapshot, setSnapshot] = useState<VoiceRecordingsSnapshot | null>(null);
  const [loading, setLoading] = useState(false);
  const generation = useRef(0);
  const refresh = useCallback(async () => {
    const request = ++generation.current;
    setLoading(true);
    try {
      const result = api ? await api.list() : unavailable;
      if (generation.current === request) setSnapshot(result);
    } catch {
      if (generation.current === request) setSnapshot(unavailable);
    } finally {
      if (generation.current === request) setLoading(false);
    }
  }, [api]);
  useEffect(() => {
    const onFocus = () => { void refresh(); };
    const onVisible = () => { if (document.visibilityState === 'visible') void refresh(); };
    void refresh();
    window.addEventListener('focus', onFocus);
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      generation.current++;
      window.removeEventListener('focus', onFocus);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [refresh]);
  return { snapshot, loading, refresh };
}

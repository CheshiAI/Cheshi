import { useEffect, useState } from 'react';
import { cheshiDesktop } from '../../cheshiDesktop';
import type { SettingsApi, TypeSafeSettings } from '../../../../shared/settings';

export function useAutopilotMenu(api = cheshiDesktop?.settings): [boolean, boolean] {
  const [received, setReceived] = useState<{ api: SettingsApi; state: TypeSafeSettings } | null>(null);
  useEffect(() => {
    if (!api) return;
    let disposed = false;
    let changed = false;
    const receive = (state: TypeSafeSettings) => {
      if (!disposed) setReceived({ api, state });
    };
    const unsubscribe = api.onTypeSafeChanged(state => { changed = true; receive(state); });
    void api.getTypeSafe().then(state => { if (!changed) receive(state); })
      .catch(() => { if (!disposed && !changed) setReceived(null); });
    return () => { disposed = true; unsubscribe(); };
  }, [api]);
  const state = received?.api === api ? received?.state : null;
  const available = !!state && state.source !== 'none' && state.maskedKey !== null && state.error === null;
  return [available && state?.autopilotMenuVisible === true, available];
}

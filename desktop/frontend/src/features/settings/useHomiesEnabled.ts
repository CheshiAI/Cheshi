import { useEffect, useState } from 'react';
import { cheshiDesktop } from '../../cheshiDesktop';
import type { SettingsApi } from '../../../../shared/settings';

export const homiesDisabledReason = 'Enable Homies in Settings to use Worker and Docker.';
/** Subscribe before reading so a slow initial response cannot overwrite a newer window update. */
export function useHomiesEnabled(api: SettingsApi | undefined = cheshiDesktop?.settings) {
  const [enabled, setEnabled] = useState<boolean | null>(null);
  useEffect(() => {
    let disposed = false, changed = false;
    setEnabled(null);
    if (!api) { setEnabled(false); return; }
    const unsubscribe = api.onHomiesEnabledChanged(value => { changed = true; if (!disposed) setEnabled(value === true); });
    void api.getHomiesEnabled().then(value => {
      if (!disposed && !changed) setEnabled(value === true);
    }, () => { if (!disposed && !changed) setEnabled(false); });
    return () => { disposed = true; unsubscribe(); };
  }, [api]);
  return enabled;
}

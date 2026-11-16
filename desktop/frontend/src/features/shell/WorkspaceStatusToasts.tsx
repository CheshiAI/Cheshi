import { useEffect, useRef, useState } from 'react';
import { StatusToast, type StatusToastMessage } from '../../shared/ui/StatusToast';

/** Subscribe in the foreground renderer; host DOM portals cannot cover a native child view. */
export function WorkspaceStatusToasts() {
  const [message, setMessage] = useState<StatusToastMessage | null>(null);
  const sequence = useRef(0);
  useEffect(() => window.workspaceSurface?.onStatusToast?.(incoming => {
    setMessage({ ...incoming, id: ++sequence.current });
  }), []);
  return message && <StatusToast message={message} onDismiss={() => setMessage(null)} />;
}

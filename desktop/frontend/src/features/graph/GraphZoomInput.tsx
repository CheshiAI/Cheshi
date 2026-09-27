import { useRef, useState } from 'react';

import { NeumorphicTextField, Tooltip } from '../../shared/ui';

export function GraphZoomInput({ percent, onCommit }: {
  percent: number;
  onCommit: (percent: number) => void;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  const cancelled = useRef(false);

  return <Tooltip<HTMLInputElement> content="Zoom percentage (5–999). Press Enter to apply or Escape to cancel.">
    {trigger => <NeumorphicTextField
      {...trigger}
      variant="standard"
      className="codegraph-zoom-input"
      aria-label="Graph zoom percentage"
      inputMode="numeric"
      maxLength={4}
      value={draft ?? `${percent}%`}
      onFocus={event => { trigger.onFocus?.(event); event.currentTarget.select(); }}
      onChange={event => {
        const value = event.target.value;
        if (/^\d{0,3}%?$/.test(value)) setDraft(value);
      }}
      onBlur={event => {
        trigger.onBlur?.(event);
        if (!cancelled.current && draft !== null) {
          const value = draft.trim().replace(/%$/, '').trim();
          const next = Number(value);
          if (value && Number.isFinite(next)) onCommit(next);
        }
        cancelled.current = false;
        setDraft(null);
      }}
      onKeyDown={event => {
        if (event.nativeEvent.isComposing || (event.key !== 'Enter' && event.key !== 'Escape')) return;
        event.preventDefault();
        event.stopPropagation();
        cancelled.current = event.key === 'Escape';
        event.currentTarget.blur();
      }}
    />}
  </Tooltip>;
}

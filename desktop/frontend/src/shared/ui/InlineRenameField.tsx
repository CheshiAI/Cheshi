import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { NeumorphicTextField } from './NeumorphicTextField';
import styles from './InlineRenameField.module.css';

export function InlineRenameField({ initialTitle, inputLabel, maxLength, children, onSave, onClose }: {
  initialTitle: string;
  inputLabel: string;
  maxLength?: number;
  children?: ReactNode;
  onSave(title: string): Promise<unknown>;
  onClose(): void;
}) {
  const [title, setTitle] = useState(initialTitle);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const saving = useRef(false), composing = useRef(false);
  const errorId = useId();
  useEffect(() => { input.current?.focus(); input.current?.select(); }, []);
  async function save() {
    if (saving.current || composing.current) return;
    const next = title.trim();
    if (!next) { setError('Title must not be empty.'); input.current?.focus(); return; }
    if (next === initialTitle) { onClose(); return; }
    saving.current = true; setPending(true); setError(null);
    try { await onSave(next); onClose(); }
    catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Title could not be saved.');
      input.current?.focus();
    } finally { saving.current = false; setPending(false); }
  }
  return <form className={styles.root} aria-label={`Rename ${inputLabel.toLowerCase()}`} aria-busy={pending}
    onSubmit={event => { event.preventDefault(); void save(); }}
    onBlur={event => { if (!saving.current && !event.currentTarget.contains(event.relatedTarget)) onClose(); }}
    onKeyDown={event => {
      event.stopPropagation();
      const inComposition = composing.current || event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229;
      if (event.key === 'Enter') { event.preventDefault(); if (!inComposition) void save(); }
      if (event.key === 'Escape' && !inComposition) { event.preventDefault(); if (!saving.current) onClose(); }
    }}>
    <NeumorphicTextField ref={input} className={styles.field} aria-label={inputLabel} value={title}
      autoComplete="off" spellCheck={false} maxLength={maxLength} readOnly={pending}
      aria-invalid={error ? true : undefined} aria-describedby={error ? errorId : undefined}
      onCompositionStart={() => { composing.current = true; }} onCompositionEnd={() => { composing.current = false; }}
      onChange={event => { setTitle(event.target.value); setError(null); }}
      onClear={() => { setTitle(''); setError(null); }} clearLabel="Clear title" />
    {children}
    {error && <p id={errorId} className={styles.error} role="alert">{error}</p>}
  </form>;
}

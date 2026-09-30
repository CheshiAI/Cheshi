import { useEffect, useRef, useState } from 'react';
import { AlignCenter, AlignLeft, AlignRight, Bold, IndentDecrease, IndentIncrease, Italic, List, ListOrdered, Redo2, RemoveFormatting, Strikethrough, Underline, Undo2 } from 'lucide-react';
import { NeumorphicButton, NeumorphicSurface } from '../../shared/ui';
import { TooltipButton } from '../../shared/ui/TooltipButton';
import { replyPreviewDocument, serializeReplyDocument } from './mailReplyDocument';
import styles from './MailReplyEditor.module.css';

const commands = [
  ['bold', 'Bold', Bold], ['italic', 'Italic', Italic], ['underline', 'Underline', Underline],
  ['strikeThrough', 'Strikethrough', Strikethrough], ['justifyLeft', 'Align left', AlignLeft],
  ['justifyCenter', 'Align center', AlignCenter], ['justifyRight', 'Align right', AlignRight],
  ['insertUnorderedList', 'Bulleted list', List], ['insertOrderedList', 'Numbered list', ListOrdered],
  ['outdent', 'Decrease indent', IndentDecrease], ['indent', 'Increase indent', IndentIncrease],
  ['removeFormat', 'Clear formatting', RemoveFormatting], ['undo', 'Undo', Undo2], ['redo', 'Redo', Redo2],
] as const;

export function MailReplyEditor({ html, disabled, active, remoteImages, onLoadImages, onChange }: {
  html: string; disabled: boolean; active: boolean; remoteImages: boolean; onLoadImages: () => void;
  onChange: (html: string, text: string) => void;
}) {
  const frame = useRef<HTMLIFrameElement>(null);
  const latest = useRef({ disabled, active, onChange });
  latest.current = { disabled, active, onChange };
  const savedRange = useRef<Range | null>(null);
  const cleanup = useRef<(() => void) | null>(null);
  const [preview, setPreview] = useState(() => replyPreviewDocument(html, remoteImages, window));
  const [pressed, setPressed] = useState<string[]>([]);
  const consent = useRef(remoteImages);
  useEffect(() => () => cleanup.current?.(), []);
  useEffect(() => {
    if (remoteImages === consent.current) return;
    consent.current = remoteImages;
    // CSP cannot be relaxed in place. Preserve current content before reloading the frame.
    setPreview(replyPreviewDocument(html, remoteImages, window));
  }, [remoteImages, html]);
  useEffect(() => {
    const body = frame.current?.contentDocument?.body;
    if (body) body.contentEditable = String(!disabled);
  }, [disabled]);
  useEffect(() => {
    if (active && !disabled) frame.current?.contentDocument?.body?.focus();
  }, [active, disabled]);

  const changed = () => {
    const doc = frame.current?.contentDocument;
    if (doc?.body && !latest.current.disabled) latest.current.onChange(serializeReplyDocument(doc), doc.body.innerText);
  };
  const command = (name: string, value?: string) => {
    const doc = frame.current?.contentDocument;
    if (!doc || disabled) return;
    doc.body.focus();
    const selection = doc.getSelection();
    if (savedRange.current?.startContainer.isConnected && selection) {
      selection.removeAllRanges(); selection.addRange(savedRange.current);
    }
    // Chromium's native editing commands preserve arbitrary mail tables/styles and its undo history.
    doc.execCommand('styleWithCSS', false, 'true');
    doc.execCommand(name, false, value);
    changed();
  };
  const loaded = () => {
    cleanup.current?.();
    const current = frame.current, doc = current?.contentDocument;
    if (!current || !doc?.body) return;
    savedRange.current = null;
    doc.body.contentEditable = String(!latest.current.disabled);
    doc.body.setAttribute('role', 'textbox'); doc.body.setAttribute('aria-label', 'Compose message body');
    doc.body.setAttribute('aria-multiline', 'true');
    const measure = () => { current.style.height = `${Math.max(240, Math.min(50_000, Math.ceil(doc.body.getBoundingClientRect().height)))}px`; };
    const observer = new ResizeObserver(measure); observer.observe(doc.body);
    const selectionChanged = () => {
      const selection = doc.getSelection();
      if (selection?.rangeCount && doc.body.contains(selection.anchorNode)) savedRange.current = selection.getRangeAt(0).cloneRange();
      setPressed(commands.filter(([name]) => doc.queryCommandState(name)).map(([name]) => name));
    };
    const paste = (event: ClipboardEvent) => {
      event.preventDefault();
      if (latest.current.disabled) return;
      const html = event.clipboardData?.getData('text/html');
      if (html) {
        const safe = replyPreviewDocument(html, remoteImages, window);
        const fragment = new DOMParser().parseFromString(safe.srcDoc, 'text/html');
        fragment.querySelectorAll('style').forEach(element => element.remove());
        doc.execCommand('insertHTML', false, fragment.body.innerHTML);
      } else doc.execCommand('insertText', false, event.clipboardData?.getData('text/plain') ?? '');
      changed();
    };
    const prevent = (event: Event) => event.preventDefault();
    const click = (event: MouseEvent) => { if ((event.target as Element)?.closest?.('a')) event.preventDefault(); };
    doc.addEventListener('input', changed); doc.addEventListener('selectionchange', selectionChanged);
    doc.addEventListener('paste', paste); doc.addEventListener('drop', prevent); doc.addEventListener('click', click);
    measure();
    if (latest.current.active && !latest.current.disabled) {
      doc.body.focus();
      const range = doc.createRange(); range.selectNodeContents(doc.body.firstElementChild ?? doc.body); range.collapse(true);
      doc.getSelection()?.removeAllRanges(); doc.getSelection()?.addRange(range);
    }
    cleanup.current = () => {
      observer.disconnect(); doc.removeEventListener('input', changed); doc.removeEventListener('selectionchange', selectionChanged);
      doc.removeEventListener('paste', paste); doc.removeEventListener('drop', prevent); doc.removeEventListener('click', click);
    };
  };
  return <div className={styles.root}>
    <div className={styles.toolbar} role="toolbar" aria-label="Message formatting">
      <NeumorphicSurface><select aria-label="Font" disabled={disabled} defaultValue="Helvetica" onChange={event => command('fontName', event.target.value)}>
        {['Helvetica', 'Arial', 'Georgia', 'Times New Roman', 'Courier New'].map(font => <option key={font}>{font}</option>)}
      </select></NeumorphicSurface>
      <NeumorphicSurface><select aria-label="Font size" disabled={disabled} defaultValue="2" onChange={event => command('fontSize', event.target.value)}>
        {[['1', '10'], ['2', '12'], ['3', '16'], ['4', '18'], ['5', '24'], ['6', '32'], ['7', '48']].map(([value, label]) => <option key={value} value={value}>{label}</option>)}
      </select></NeumorphicSurface>
      <input type="color" aria-label="Text color" defaultValue="#18212a" disabled={disabled} onChange={event => command('foreColor', event.target.value)} />
      {commands.map(([name, label, Icon]) => <TooltipButton key={name} variant="ghost" size="icon" title={label} aria-label={label}
        aria-pressed={pressed.includes(name)} disabled={disabled} onMouseDown={event => event.preventDefault()} onClick={() => command(name)}><Icon aria-hidden="true" /></TooltipButton>)}
    </div>
    {preview.hasRemoteImages && !remoteImages && <div className={styles.images}><span>Remote images are hidden.</span>
      <NeumorphicButton variant="ghost" onClick={onLoadImages}>Load images</NeumorphicButton></div>}
    <iframe ref={frame} className={styles.frame} title="Reply message editor" sandbox="allow-same-origin" referrerPolicy="no-referrer"
      srcDoc={preview.srcDoc} onLoad={loaded} />
  </div>;
}

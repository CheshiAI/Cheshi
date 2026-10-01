import { useLayoutEffect, useRef } from 'react';
import { mailLink } from './mailHtmlDocument';
import { mailReadDocument } from './mailReadDocument';
import styles from './MailHtmlBody.module.css';

const READING_STYLE = `:host{all:initial;display:block;min-width:0;max-width:100%;isolation:isolate;contain:content}
html,body{display:block;width:100%!important;max-width:100%!important;min-width:0!important;margin:0!important;box-sizing:border-box;color-scheme:light}
html{font:16px "Times New Roman",serif;line-height:normal}
:where(html){color:var(--cheshi-mail-read-text,var(--text,black))}
:where(table){color:inherit}
*:not(img){height:auto!important;min-height:0!important;max-height:none!important;overflow:visible!important}
body{display:flow-root;overflow-wrap:anywhere}img{max-width:100%;height:auto}table{max-width:100%}pre{white-space:pre-wrap;overflow-wrap:anywhere}`;

export function MailHtmlBody({ srcDoc, remoteImagesAllowed = false }: { srcDoc: string; remoteImagesAllowed?: boolean }) {
  const hostRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const shadow = host.shadowRoot ?? host.attachShadow({ mode: 'open' });
    const content = mailReadDocument(srcDoc, remoteImagesAllowed, window);
    const style = document.createElement('style');
    style.textContent = READING_STYLE;
    shadow.replaceChildren(style, content.html);
    // Preserve the light-document default on authored backgrounds. Only an
    // unpainted reading canvas inherits the app theme; authored colors still win.
    const painted = [content.html, content.body].some(element => {
      const computed = window.getComputedStyle(element);
      return !['transparent', 'rgba(0, 0, 0, 0)'].includes(computed.backgroundColor)
        || computed.backgroundImage !== 'none';
    });
    content.html.style.setProperty('--cheshi-mail-read-text', painted ? 'black' : 'var(--text,black)');
    const openLink = (event: Event) => {
      const mouse = event as MouseEvent;
      const anchor = (event.target as Element | null)?.closest?.('a[href]');
      if (!anchor) return;
      event.preventDefault();
      if (mouse.button !== 0 && mouse.button !== 1) return;
      const href = mailLink(anchor.getAttribute('href') ?? '');
      if (href) window.open(href, '_blank', 'noopener,noreferrer');
    };
    shadow.addEventListener('click', openLink);
    shadow.addEventListener('auxclick', openLink);
    return () => {
      shadow.removeEventListener('click', openLink);
      shadow.removeEventListener('auxclick', openLink);
      shadow.replaceChildren();
    };
  }, [srcDoc, remoteImagesAllowed]);
  return <div className={styles.root}><div ref={hostRef} role="document" aria-label="HTML message content" /></div>;
}

import { Check, Copy, Image as ImageIcon } from 'lucide-react';
import { Children, useEffect, useState, type ReactNode } from 'react';
import ReactMarkdown, { defaultUrlTransform, type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';

import { cheshiDesktop } from '../../cheshiDesktop';
import { localFileLinkPath } from '../../../../shared/local-file-link';
import { LiquidGlassPanel } from '../../shared/ui';
import styles from './ChatView.module.css';
import markdownStyles from './MessageContent.module.css';

interface MessageContentProps {
  text: string;
  renderLocalImages?: boolean;
}

interface ContentSegment {
  kind: 'text' | 'code';
  value: string;
  language?: string;
}

function jsonSegmentFromText(text: string): ContentSegment | null {
  const trimmed = text.trim();
  const looksLikeJson = (trimmed.startsWith('{') && trimmed.endsWith('}'))
    || (trimmed.startsWith('[') && trimmed.endsWith(']'));
  if (!looksLikeJson) return null;
  try {
    const value: unknown = JSON.parse(trimmed);
    if (typeof value !== 'object' || value === null) return null;
    return { kind: 'code', value: JSON.stringify(value, null, 2), language: 'json' };
  } catch {
    return null;
  }
}

function isGitHubUrl(href: string): boolean {
  return /^https?:\/\/(?:www\.)?github\.com(?:[/:?#]|$)/i.test(href);
}

function LocalFileAnchor({ href, children }: { href: string; children: ReactNode }) {
  const [error, setError] = useState<string | null>(null);
  const openFile = async () => {
    setError(null);
    if (!cheshiDesktop?.openLocalFileLink) {
      setError('File links are available in the desktop app.');
      return;
    }
    try { await cheshiDesktop.openLocalFileLink(href); }
    catch { setError('Could not open this file. It may have been moved or deleted.'); }
  };
  return <>
    <a href={href} title={localFileLinkPath(href) ?? href} onClick={event => {
      event.preventDefault();
      void openFile();
    }} onAuxClick={event => event.preventDefault()}>{children}</a>
    {error && <span role="alert"> {error}</span>}
  </>;
}

function MessageAnchor({ href, children }: { href: string; children: ReactNode }) {
  if (!/^https?:\/\//i.test(href)) {
    return localFileLinkPath(href) ? <LocalFileAnchor href={href}>{children}</LocalFileAnchor> : <>{children}</>;
  }
  const github = isGitHubUrl(href);
  return (
    <a href={href} rel="noreferrer" target="_blank">
      {github && <span aria-hidden="true" className={styles.externalLinkIcon} />}
      <span>{children}</span>
    </a>
  );
}

function imageName(imagePath: string): string {
  return imagePath.replaceAll('\\', '/').split('/').pop() || 'Attached image';
}

function LocalImage({ imagePath }: { imagePath: string }) {
  const [previewUrl, setPreviewUrl] = useState<string | null>();
  const name = imageName(imagePath);

  useEffect(() => {
    let active = true;
    setPreviewUrl(undefined);
    if (!cheshiDesktop?.getCodexChatAttachmentPreview) {
      setPreviewUrl(null);
      return () => { active = false; };
    }
    void cheshiDesktop.getCodexChatAttachmentPreview(imagePath)
      .then((value) => {
        if (active) setPreviewUrl(value);
      })
      .catch(() => {
        if (active) setPreviewUrl(null);
      });
    return () => { active = false; };
  }, [imagePath]);

  if (previewUrl) {
    return (
      <span className={styles.messageImageAttachment}>
        <img alt={name} src={previewUrl} />
      </span>
    );
  }
  return (
    <span
      aria-label={`Attached image: ${name}`}
      className={styles.messageImageAttachment}
      data-loading={previewUrl === undefined ? 'true' : undefined}
      role="img"
    >
      <ImageIcon aria-hidden="true" />
    </span>
  );
}

function localImageContent(children: ReactNode): ReactNode {
  return Children.map(children, (child) => {
    if (typeof child !== 'string') return child;
    const nodes: ReactNode[] = [];
    let images: ReactNode[] = [];
    const flushImages = () => {
      if (images.length === 0) return;
      nodes.push(<span className={markdownStyles.imageAttachments} key={`images:${nodes.length}`}>{images}</span>);
      images = [];
    };
    const pattern = /(^|\n)\[Image:\s*(.+)](?=\n|$)/g;
    let offset = 0;
    for (const match of child.matchAll(pattern)) {
      if (!match[2]) continue;
      const index = match.index + (match[1]?.length ?? 0);
      const between = child.slice(offset, index);
      if (between.trim()) {
        flushImages();
        nodes.push(between);
      }
      images.push(<LocalImage imagePath={match[2]} key={`${index}:${match[2]}`} />);
      offset = match.index + match[0].length;
    }
    flushImages();
    if (offset < child.length) nodes.push(child.slice(offset));
    return nodes.length > 0 ? nodes : child;
  });
}

function LocalImageParagraph({ children }: { children?: ReactNode }) {
  const parts = Children.toArray(children);
  const imagesOnly = parts.length > 0 && parts.every(child => typeof child === 'string'
    && child.split('\n').every(line => !line.trim() || /^\[Image:\s*.+]$/.test(line)));
  const content = localImageContent(children);
  // Separate image-only Markdown paragraphs still share a horizontal thumbnail row.
  return imagesOnly ? <>{content}</> : <p>{content}</p>;
}

const markdownComponents: Components = {
  a: ({ href, children }) => <MessageAnchor href={href ?? ''}>{children}</MessageAnchor>,
  // Markdown images do not initiate network or filesystem access. Local previews
  // are available only through the explicit attachment marker and desktop bridge.
  img: ({ alt }) => <span>{alt || 'Image'}</span>,
  code: ({ children }) => <code className={styles.inlineCode}>{children}</code>,
  pre: ({ node, children }) => {
    const code = node?.children.find((child) => child.type === 'element' && child.tagName === 'code');
    if (!code || code.type !== 'element') return <pre>{children}</pre>;
    const value = code.children.map((child) => child.type === 'text' ? child.value : '').join('');
    const classNames = code.properties.className;
    const language = Array.isArray(classNames)
      ? classNames.find((name) => typeof name === 'string' && name.startsWith('language-'))
      : undefined;
    return <CodeBlock code={value.replace(/\n$/, '')} language={typeof language === 'string' ? language.slice(9) : undefined} />;
  },
  table: ({ children }) => (
    <LiquidGlassPanel className={markdownStyles.tableScroll} data-liquid-glass-backdrop="true" role="region" aria-label="Table" tabIndex={0}>
      <table>{children}</table>
    </LiquidGlassPanel>
  ),
};

const localImageComponents: Components = {
  ...markdownComponents,
  p: LocalImageParagraph,
};

function CodeBlock({ code, language }: { code: string; language?: string }) {
  const [copied, setCopied] = useState(false);

  const copy = async () => {
    await navigator.clipboard.writeText(code);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1_500);
  };

  return (
    <LiquidGlassPanel as="section" className={styles.codeBlock} data-liquid-glass-backdrop="true">
      <header>
        <span>{language || 'code'}</span>
        <button className={styles.copyButton} type="button" onClick={() => void copy()}>
          {copied ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}
          {copied ? 'Copied' : 'Copy'}
        </button>
      </header>
      <pre><code>{code}</code></pre>
    </LiquidGlassPanel>
  );
}

export function MessageContent({ renderLocalImages = false, text }: MessageContentProps) {
  const jsonSegment = jsonSegmentFromText(text);
  if (jsonSegment) return <CodeBlock code={jsonSegment.value} language={jsonSegment.language} />;
  return (
    <div className={markdownStyles.markdown}>
      <ReactMarkdown
        components={renderLocalImages ? localImageComponents : markdownComponents}
        remarkPlugins={[remarkGfm]}
        urlTransform={(url, key) => key === 'href' && localFileLinkPath(url) ? url : defaultUrlTransform(url)}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
}

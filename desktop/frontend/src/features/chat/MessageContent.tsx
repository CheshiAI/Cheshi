import { TooltipTarget } from '../../shared/ui/TooltipTarget';
import { Image as ImageIcon } from 'lucide-react';
import { Children, createContext, useContext, useEffect, useState, type ComponentPropsWithoutRef, type ReactNode } from 'react';
import ReactMarkdown, { defaultUrlTransform, type Components, type ExtraProps } from 'react-markdown';
import remarkGfm from 'remark-gfm';

import { cheshiDesktop } from '../../cheshiDesktop';
import { localFileLinkPath } from '../../../../shared/local-file-link';
import { CodePanel, LiquidGlassPanel } from '../../shared/ui';
import styles from './ChatView.module.css';
import markdownStyles from './MessageContent.module.css';
import { FileEvidence } from './FileEvidence';
import { fileEvidence } from './fileEvidenceModel';
import { flashSourceTarget } from '../../../../shared/flash-memory';
import { FlashSourceLink } from './FlashSourceLink';

export const LocalFileLinkContext = createContext<((href: string) => Promise<void>) | null>(null);

interface MessageContentProps {
  text: string;
  renderLocalImages?: boolean;
  presentation?: 'default' | 'description';
  mention?: { id: string; name: string };
  reviewFileContext?: string;
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
  const openLocalFile = useContext(LocalFileLinkContext) ?? cheshiDesktop?.openLocalFileLink;
  const openFile = async () => {
    setError(null);
    if (!openLocalFile) {
      setError('File links are available in the desktop app.');
      return;
    }
    try { await openLocalFile(href); }
    catch { setError('Could not open this file. It may have been moved or deleted.'); }
  };
  return <>
    <TooltipTarget content={localFileLinkPath(href) ?? href}>
      <a href={href}  onClick={event => {
        event.preventDefault();
        void openFile();
      }} onAuxClick={event => event.preventDefault()}>{children}</a>
    </TooltipTarget>
    {error && <span role="alert"> {error}</span>}
  </>;
}

function MessageAnchor({ href, children }: { href: string; children: ReactNode }) {
  const source = flashSourceTarget(href);
  if (source) return <FlashSourceLink href={href} target={source}>{children}</FlashSourceLink>;
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

function markdownCodeBlock({ node, children }: ComponentPropsWithoutRef<'pre'> & ExtraProps, reviewFileContext?: string) {
  const code = node?.children.find(child => child.type === 'element' && child.tagName === 'code');
  if (!code || code.type !== 'element') return <pre>{children}</pre>;
  const value = code.children.map(child => child.type === 'text' ? child.value : '').join('');
  const classNames = code.properties.className;
  const languageClass = Array.isArray(classNames)
    ? classNames.find(name => typeof name === 'string' && name.startsWith('language-')) : undefined;
  const language = typeof languageClass === 'string' ? languageClass.slice(9) : undefined;
  const files = reviewFileContext === undefined ? null : fileEvidence(value, language, reviewFileContext);
  return files ? <FileEvidence files={files} renderLink={(path, name) => <LocalFileAnchor href={path}>{name}</LocalFileAnchor>} />
    : <CodePanel code={value.replace(/\n$/, '')} language={language} />;
}

const markdownComponents: Components = {
  a: ({ href, children }) => <MessageAnchor href={href ?? ''}>{children}</MessageAnchor>,
  // Markdown images do not initiate network or filesystem access. Local previews
  // are available only through the explicit attachment marker and desktop bridge.
  img: ({ alt }) => <span>{alt || 'Image'}</span>,
  code: ({ children }) => <code className={styles.inlineCode}>{children}</code>,
  pre: props => markdownCodeBlock(props),
  table: ({ children }) => (
    <LiquidGlassPanel className={markdownStyles.tableScroll} role="region" aria-label="Table" tabIndex={0}>
      <table>{children}</table>
    </LiquidGlassPanel>
  ),
};

const localImageComponents: Components = {
  ...markdownComponents,
  p: LocalImageParagraph,
};

const descriptionComponents: Components = {
  ...markdownComponents,
  pre: ({ children }) => <pre>{children}</pre>,
  code: ({ children }) => <code>{children}</code>,
};

export function MessageContent({ renderLocalImages = false, text, presentation = 'default', mention, reviewFileContext }: MessageContentProps) {
  const description = presentation === 'description';
  const jsonSegment = description ? null : jsonSegmentFromText(text);
  if (jsonSegment) return <CodePanel code={jsonSegment.value} language={jsonSegment.language} />;
  const mentionLabel = mention ? `@${mention.name}` : '';
  const mentionOffset = text.length - text.trimStart().length;
  const addressed = mention && text.slice(mentionOffset).startsWith(mentionLabel)
    && /^(?:$|[\s,:：])/.test(text.slice(mentionOffset + mentionLabel.length));
  const baseComponents = description ? descriptionComponents : renderLocalImages ? localImageComponents : markdownComponents;
  const components: Components = !description && reviewFileContext !== undefined
    ? { ...baseComponents, pre: props => markdownCodeBlock(props, reviewFileContext) } : baseComponents;
  const mentionComponents: Components = addressed ? { ...components, p: ({ node, children }) => {
    const parts = Children.toArray(children);
    const first = parts[0];
    if (node?.position?.start.offset === mentionOffset && typeof first === 'string' && first.startsWith(mentionLabel)) {
      parts.splice(0, 1, <span key="mention" className={markdownStyles.mention} data-mention-id={mention.id}>{mentionLabel}</span>, first.slice(mentionLabel.length));
    }
    return renderLocalImages ? <LocalImageParagraph>{parts}</LocalImageParagraph> : <p>{parts}</p>;
  } } : components;
  return (
    <div className={`${markdownStyles.markdown}${description ? ` ${markdownStyles.description}` : ''}`}>
      <ReactMarkdown
        components={mentionComponents}
        remarkPlugins={[remarkGfm]}
        urlTransform={(url, key) => key === 'href' && (flashSourceTarget(url) || localFileLinkPath(url)) ? url : defaultUrlTransform(url)}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
}

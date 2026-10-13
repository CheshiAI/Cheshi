import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';

import { CodePanel, LiquidGlassPanel } from '../../shared/ui';
import styles from './GitIssueMarkdown.module.css';

function issueLink(href: string, repository: string | undefined, issueNumber: number): string | undefined {
  if (!href) return undefined;
  try {
    const url = new URL(href, repository ? `https://github.com/${repository}/issues/${issueNumber}` : undefined);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.href : undefined;
  } catch { return undefined; }
}

const markdownComponents: Components = {
  // Remote issue content must not fetch images or access local files automatically.
  img: ({ alt }) => <span>{alt || 'Image'}</span>,
  pre: ({ node, children }) => {
    const code = node?.children.find(child => child.type === 'element' && child.tagName === 'code');
    if (!code || code.type !== 'element') return <pre>{children}</pre>;
    const classNames = code.properties.className;
    const language = Array.isArray(classNames) ? classNames.find(name => typeof name === 'string' && name.startsWith('language-')) : undefined;
    const text = code.children.map(child => child.type === 'text' ? child.value : '').join('').replace(/\n$/, '');
    return <CodePanel code={text} language={typeof language === 'string' ? language.slice(9) : undefined} />;
  },
  table: ({ children }) => <LiquidGlassPanel className={styles.table} role="region" aria-label="Issue table" tabIndex={0}>
    <table>{children}</table>
  </LiquidGlassPanel>,
};

export function GitIssueMarkdown({ text, repository, issueNumber }: { text: string; repository?: string; issueNumber: number }) {
  return <div className={styles.body}>
    <ReactMarkdown remarkPlugins={[remarkGfm]} skipHtml components={{ ...markdownComponents,
      a: ({ href, children }) => href ? <a href={href} target="_blank" rel="noreferrer">{children}</a> : <>{children}</>,
    }} urlTransform={(url, key) => key === 'href' ? issueLink(url, repository, issueNumber) : undefined}>
      {text}
    </ReactMarkdown>
  </div>;
}

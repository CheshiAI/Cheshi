import { ArrowLeft, ArrowUpRight, BookOpen, CircleQuestionMark, X } from 'lucide-react';
import { useLayoutEffect, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import { LiquidGlassPanel, NeumorphicButton, NeumorphicTextField, SearchClearButton } from '../../shared/ui';
import type { HelpLanguage } from '../../shared/useHelpLanguage';
import { searchHelp, type HelpArticle } from './helpCatalog';
import { getHelpTranslations } from './helpTranslations';
import styles from './HelpPanel.module.css';

interface HelpPanelProps {
  id: string;
  open: boolean;
  articles: HelpArticle[];
  language?: HelpLanguage;
  onClose(): void;
}

export function HelpPanel({ id, open, articles, language = 'en', onClose }: HelpPanelProps) {
  const text = getHelpTranslations(language);
  const [query, setQuery] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const focusBody = useRef(false);
  const positions = useRef(new Map<string, number>());
  const selected = articles.find(article => article.id === selectedId);
  const results = searchHelp(articles, query);
  const location = selectedId ?? `search:${query}`;
  const rememberPosition = () => {
    if (bodyRef.current) positions.current.set(location, bodyRef.current.scrollTop);
  };
  const select = (articleId: string | null) => {
    rememberPosition();
    focusBody.current = true;
    setSelectedId(articleId);
  };

  useLayoutEffect(() => {
    if (open) inputRef.current?.focus({ preventScroll: true });
  }, [open]);
  useLayoutEffect(() => {
    if (!open || !bodyRef.current) return;
    bodyRef.current.scrollTop = positions.current.get(location) ?? 0;
    // Announce the new document while allowing Tab to leave this non-modal panel.
    if (selectedId || focusBody.current) bodyRef.current.focus({ preventScroll: true });
    focusBody.current = false;
  }, [location, open, selectedId]);

  return <LiquidGlassPanel as="aside" id={id} lang={language} role="complementary" aria-labelledby={`${id}-title`}
    aria-hidden={!open} inert={!open} data-open={open ? 'true' : 'false'}
    className={styles.panel} data-liquid-glass-backdrop="true"
    onKeyDown={event => {
      if (event.key === 'Escape' && !event.nativeEvent.isComposing) {
        event.stopPropagation(); event.preventDefault(); onClose();
      }
    }}>
    <header className={styles.header}>
      <CircleQuestionMark aria-hidden="true" />
      <h2 id={`${id}-title`}>{text.title}</h2>
      <NeumorphicButton raised size="icon" aria-label={text.close} title={text.close} onClick={onClose}>
        <X aria-hidden="true" />
      </NeumorphicButton>
    </header>
    <div className={styles.searchArea} role="search" aria-label={text.search}>
      <NeumorphicTextField ref={inputRef} type="search" placeholder={text.searchPlaceholder}
        aria-label={text.search} value={query} maxLength={200}
        onChange={event => { rememberPosition(); setQuery(event.target.value); setSelectedId(null); }}
        trailingAction={query ? <SearchClearButton aria-label={text.clearSearch} onClick={() => {
          rememberPosition(); setQuery(''); setSelectedId(null); inputRef.current?.focus();
        }} /> : undefined} />
    </div>
    <div ref={bodyRef} className={styles.body} tabIndex={0}
      aria-label={selected?.title ?? text.topics} onScroll={rememberPosition}>
      {selected ? <>
        <NeumorphicButton raised size="standard" onClick={() => select(null)}>
          <ArrowLeft aria-hidden="true" />{text.back}
        </NeumorphicButton>
        <article className={styles.document}>
          <ReactMarkdown components={{
            // Bundled help is text-only and never fetches remote resources.
            img: ({ alt }) => <span>{alt}</span>,
            a: ({ children }) => <span>{children}</span>,
          }}>{selected.markdown}</ReactMarkdown>
        </article>
        <nav className={styles.related} aria-label={text.related}>
          <h3>{text.related}</h3>
          {selected.related.map(relatedId => {
            const article = articles.find(item => item.id === relatedId);
            return article && <NeumorphicButton raised size="standard" key={article.id} onClick={() => select(article.id)}>
              {article.title}<ArrowUpRight aria-hidden="true" />
            </NeumorphicButton>;
          })}
        </nav>
      </> : <>
        {!query.trim() && <section className={styles.popular} aria-label={text.popular}>
          <h3>{text.popular}</h3>
          {['projects', 'local-history', 'git'].map(articleId => {
            const article = articles.find(item => item.id === articleId);
            return article && <NeumorphicButton raised size="standard" key={article.id} onClick={() => select(article.id)}>
              {article.title}<ArrowUpRight aria-hidden="true" />
            </NeumorphicButton>;
          })}
        </section>}
        <h3>{query.trim() ? text.searchResults : text.browseTopics}</h3>
        {query.trim() && <p role="status" className={styles.muted}>{results.length
          ? text.resultCount(results.length) : text.noResults}</p>}
        <div className={styles.topics}>
          {results.map(article => <NeumorphicButton raised key={article.id} className={styles.topic}
            onClick={() => select(article.id)}>
            <BookOpen aria-hidden="true" /><span><strong>{article.title}</strong><span>{article.description}</span></span>
          </NeumorphicButton>)}
        </div>
      </>}
    </div>
    <footer className={styles.footer}>{text.footer}</footer>
  </LiquidGlassPanel>;
}

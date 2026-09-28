import { ListChecks } from 'lucide-react';
import { useCallback, useRef, type SubmitEvent } from 'react';

import { LiquidGlassSelect, LoadingIndicator, NeumorphicCheckbox, NeumorphicTextField, SearchClearButton } from '../../shared/ui';
import { TooltipButton } from '../../shared/ui/TooltipButton';
import badgeStyles from '../../shared/ui/Badge.module.css';
import type { GraphController } from './useGraphController';

const groupByOptions = [
  { value: 'directory', label: 'Directory' },
  { value: 'language', label: 'Language' },
  { value: 'kind', label: 'Symbol type' },
] as const;

export function GraphSearch({ graph }: { graph: GraphController }) {
  const searchInputRef = useRef<HTMLInputElement>(null);

  const submitSearch = (event: SubmitEvent<HTMLFormElement>): void => {
    event.preventDefault();
    void graph.runSearch();
  };

  return (
    <div className="codegraph-controls codegraph-symbol-search" aria-label="Symbol search">
      <section className="codegraph-control-section">
        <div className="codegraph-section-heading">
          <strong>Find symbol</strong>
          {graph.searching && <LoadingIndicator label="Searching" />}
        </div>
        <form className="codegraph-search" onSubmit={submitSearch}>
          <NeumorphicTextField
            variant="standard"
            ref={searchInputRef}
            value={graph.query}
            onChange={(event) => graph.setQuery(event.target.value)}
            type="search"
            aria-label="Find symbol"
            placeholder="Search functions, classes, or files"
            autoComplete="off"
            trailingAction={graph.query ? (
              <SearchClearButton
                variant="ghost"
                aria-label="Clear symbol search"
                onClick={() => {
                  graph.setQuery('');
                  requestAnimationFrame(() => searchInputRef.current?.focus());
                }}
              />
            ) : undefined}
          />
        </form>
        <div className="codegraph-results" aria-live="polite">
          {graph.results.map((result) => (
            <button
              className="codegraph-result"
              data-selected={result.id === graph.selectedId ? 'true' : undefined}
              key={result.id}
              type="button"
              onClick={() => graph.selectSearchResult(result)}
            >
              <span className={`${badgeStyles.badge} codegraph-result-kind`}>{result.kind}</span>
              <strong>{result.name}</strong>
              <small>{graph.displayPath(result.filePath)}:{result.startLine}</small>
            </button>
          ))}
          {graph.results.length === 0 && !graph.searching && (
            <p className="codegraph-hint">Enter a symbol name and press Enter to search.</p>
          )}
        </div>
      </section>
    </div>
  );
}

export function GraphSettings({ graph }: { graph: GraphController }) {
  const menuBlurSourceRef = useRef<HTMLElement | null>(null);
  const connectMenuBackdrop = useCallback((element: HTMLDivElement | null) => {
    // Sample the unscaled workspace, including the graph and inspector borders.
    menuBlurSourceRef.current = element?.closest<HTMLElement>('.codegraph-workspace') ?? null;
  }, []);
  return (
    <div ref={connectMenuBackdrop} className="codegraph-controls codegraph-settings" aria-label="Graph settings">
      <section className="codegraph-control-section">
        <div className="codegraph-section-heading">
          <strong>Graph</strong>
        </div>
        <div className="codegraph-field">
          <span>Group by</span>
          <LiquidGlassSelect
            ariaLabel="Group graph by"
            menuBlurSourceRef={menuBlurSourceRef}
            triggerAppearance="standard"
            menuAppearance="toolbar"
            menuPlacement="left"
            menuWidth={180}
            options={groupByOptions}
            value={graph.groupBy}
            onChange={graph.setGroupBy}
          />
        </div>
        <label className="codegraph-range">
          <span>Traversal depth <output className={badgeStyles.badge}>{graph.depth}</output></span>
          <input
            value={graph.depth}
            onChange={(event) => graph.setDepth(Number(event.target.value))}
            type="range"
            min="0"
            max="4"
            step="1"
          />
        </label>
        <label className="codegraph-range">
          <span>Node limit <output className={badgeStyles.badge}>{graph.limit}</output></span>
          <input
            value={graph.limit}
            onChange={(event) => graph.setLimit(Number(event.target.value))}
            type="range"
            min="12"
            max="120"
            step="12"
          />
        </label>
      </section>

      {graph.activeEdgeKinds.length > 0 && (
        <section className="codegraph-control-section codegraph-edge-section">
          <div className="codegraph-section-heading">
            <strong>Relationship types</strong>
            <TooltipButton
              variant="ghost"
              size="icon"
              type="button"
              aria-label={graph.areAllEdgeKindsSelected
                ? 'Clear all relationship types'
                : 'Select all relationship types'}
              aria-pressed={graph.areAllEdgeKindsSelected}
              title={graph.areAllEdgeKindsSelected
                ? 'Clear all relationship types'
                : 'Select all relationship types'}
              onClick={() => graph.setSelectedEdgeKinds(
                graph.areAllEdgeKindsSelected ? [] : [...graph.activeEdgeKinds],
              )}
            >
              <ListChecks aria-hidden="true" />
            </TooltipButton>
          </div>
          <div className="codegraph-edge-list">
            {graph.activeEdgeKinds.map((kind) => (
              <NeumorphicCheckbox
                aria-label={`${kind} relationship`}
                className="codegraph-edge-option"
                checked={graph.selectedEdgeKinds.includes(kind)}
                key={kind}
                onChange={(event) => graph.setSelectedEdgeKinds(
                  event.target.checked
                    ? [...graph.selectedEdgeKinds, kind]
                    : graph.selectedEdgeKinds.filter((entry) => entry !== kind),
                )}
              >
                <span className="codegraph-edge-dot" data-kind={kind} />
                <span>{kind}</span>
              </NeumorphicCheckbox>
            ))}
          </div>
        </section>
      )}

    </div>
  );
}

import { ListChecks, Search } from 'lucide-react';
import { useRef, type CSSProperties, type SubmitEvent } from 'react';

import { LiquidGlassSelect, NeumorphicButton, NeumorphicCheckbox, NeumorphicTextField, SearchClearButton } from '../../shared/ui';
import badgeStyles from '../../shared/ui/Badge.module.css';
import type { GraphController } from './useGraphController';

const groupByOptions = [
  { value: 'directory', label: 'Directory' },
  { value: 'language', label: 'Language' },
  { value: 'kind', label: 'Symbol type' },
] as const;

type RangeProgressStyle = CSSProperties & { '--codegraph-range-progress': string };

function rangeProgressStyle(value: number, min: number, max: number): RangeProgressStyle {
  const progress = Math.min(100, Math.max(0, ((value - min) / (max - min)) * 100));
  return { '--codegraph-range-progress': `${progress}%` };
}

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
          {graph.searching && <span className="codegraph-spinner" aria-label="Searching" />}
        </div>
        <form className="codegraph-search" onSubmit={submitSearch}>
          <NeumorphicTextField
            ref={searchInputRef}
            value={graph.query}
            onChange={(event) => graph.setQuery(event.target.value)}
            type="search"
            aria-label="Find symbol"
            placeholder="Search functions, classes, or files"
            autoComplete="off"
            trailingAction={graph.query ? (
              <SearchClearButton
                aria-label="Clear symbol search"
                onClick={() => {
                  graph.setQuery('');
                  requestAnimationFrame(() => searchInputRef.current?.focus());
                }}
              />
            ) : undefined}
          />
          <NeumorphicButton raised className="codegraph-search-button" type="submit" aria-label="Search">
            <Search aria-hidden="true" />
          </NeumorphicButton>
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
            <p className="codegraph-hint">Search for a symbol to open its relationship graph.</p>
          )}
        </div>
      </section>
    </div>
  );
}

export function GraphSettings({ graph }: { graph: GraphController }) {
  return (
    <div className="codegraph-controls codegraph-settings" aria-label="Graph settings">
      <section className="codegraph-control-section">
        <div className="codegraph-section-heading">
          <strong>Graph</strong>
        </div>
        <div className="codegraph-field">
          <span>Group by</span>
          <LiquidGlassSelect
            ariaLabel="Group graph by"
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
            style={rangeProgressStyle(graph.depth, 0, 4)}
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
            style={rangeProgressStyle(graph.limit, 12, 120)}
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
            <NeumorphicButton
              raised
              className="codegraph-edge-toggle"
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
            </NeumorphicButton>
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

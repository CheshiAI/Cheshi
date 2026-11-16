import { useCallback, useRef, useState, type RefObject } from 'react';
import type { EditorView } from '@codemirror/view';
import { isWorkspacePathAtOrBelow, renameWorkspacePathPrefix } from '../../shared/workspacePaths';
import { languageServerPositionAt, MAX_NAVIGATION_HISTORY, sameNavigationLocation,
  type NavigationLocation, type WorkspaceTab } from './workspaceEditorModel';

interface NavigationOptions {
  selectedPathRef: RefObject<string | null>;
  editorViewRef: RefObject<EditorView | null>;
  tabsRef: RefObject<WorkspaceTab[]>;
  loadFileRef: RefObject<(path: string, line?: number | null, reload?: boolean, character?: number | null) => Promise<void>>;
}

export function useWorkspaceEditorNavigation({ selectedPathRef, editorViewRef, tabsRef, loadFileRef }: NavigationOptions) {
  const [navigationAvailability, setNavigationAvailability] = useState({ back: false, forward: false });
  const navigationBackRef = useRef<NavigationLocation[]>([]);
  const navigationForwardRef = useRef<NavigationLocation[]>([]);
  const syncNavigationAvailability = useCallback((): void => {
    setNavigationAvailability({
      back: navigationBackRef.current.length > 0,
      forward: navigationForwardRef.current.length > 0,
    });
  }, []);

  const currentNavigationLocation = useCallback((): NavigationLocation | null => {
    const path = selectedPathRef.current;
    const view = editorViewRef.current;
    if (!path || !view) return null;
    const position = languageServerPositionAt(view, view.state.selection.main.head);
    const tab = tabsRef.current.find((candidate) => candidate.path === path);
    return {
      path,
      line: (tab?.sourceExcerpt?.startLine ?? 1) + position.line,
      character: position.character,
    };
  }, []);

  const recordNavigationOrigin = useCallback((): void => {
    const location = currentNavigationLocation();
    if (!location) return;
    const previous = navigationBackRef.current.at(-1) ?? null;
    if (!sameNavigationLocation(previous, location)) {
      navigationBackRef.current.push(location);
      if (navigationBackRef.current.length > MAX_NAVIGATION_HISTORY) navigationBackRef.current.shift();
    }
    navigationForwardRef.current = [];
    syncNavigationAvailability();
  }, [currentNavigationLocation, syncNavigationAvailability]);

  const navigateHistory = useCallback(async (direction: 'back' | 'forward'): Promise<void> => {
    const source = direction === 'back' ? navigationBackRef.current : navigationForwardRef.current;
    const destination = direction === 'back' ? navigationForwardRef.current : navigationBackRef.current;
    let targetLocation = source.pop() ?? null;
    const current = currentNavigationLocation();
    while (targetLocation && sameNavigationLocation(targetLocation, current)) {
      targetLocation = source.pop() ?? null;
    }
    if (!targetLocation) {
      syncNavigationAvailability();
      return;
    }
    if (current && !sameNavigationLocation(destination.at(-1) ?? null, current)) {
      destination.push(current);
      if (destination.length > MAX_NAVIGATION_HISTORY) destination.shift();
    }
    syncNavigationAvailability();
    await loadFileRef.current(
      targetLocation.path,
      targetLocation.line,
      false,
      targetLocation.character,
    );
  }, [currentNavigationLocation, syncNavigationAvailability]);

  const renameNavigationPath = useCallback((previousPath: string, path: string): void => {
    const rewrite = (locations: NavigationLocation[]) => locations.map(location => (
      isWorkspacePathAtOrBelow(location.path, previousPath)
        ? { ...location, path: renameWorkspacePathPrefix(location.path, previousPath, path) } : location
    ));
    navigationBackRef.current = rewrite(navigationBackRef.current);
    navigationForwardRef.current = rewrite(navigationForwardRef.current);
    syncNavigationAvailability();
  }, [syncNavigationAvailability]);

  const removeNavigationPath = useCallback((path: string): void => {
    const keep = (location: NavigationLocation) => !isWorkspacePathAtOrBelow(location.path, path);
    navigationBackRef.current = navigationBackRef.current.filter(keep);
    navigationForwardRef.current = navigationForwardRef.current.filter(keep);
    syncNavigationAvailability();
  }, [syncNavigationAvailability]);

  return { navigationAvailability, recordNavigationOrigin, navigateHistory, renameNavigationPath, removeNavigationPath };
}

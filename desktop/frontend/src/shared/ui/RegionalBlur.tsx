import { createContext, useCallback, useContext, useLayoutEffect, useMemo, useRef, type ReactNode, type RefObject } from 'react';
import { createRegionalBlurFilter } from './regionalBlurFilter';
import { createRegionalBlurController } from './regionalBlurController';

type BlurController = ReturnType<typeof createRegionalBlurController>;
const RegionalBlurContext = createContext<readonly BlurController[]>([]);

/** Context crosses HTML portals, so floating menus share the composer's source and material. */
export function RegionalBlur({ sourceRef, children }: { sourceRef: RefObject<HTMLElement | null>; children: ReactNode }) {
  const parents = useContext(RegionalBlurContext);
  const controller = useMemo(createRegionalBlurController, []);
  // A nested provider adds a background layer without losing the outer scene.
  const controllers = useMemo(() => [...parents, controller], [parents, controller]);
  const defsRef = useRef<SVGDefsElement>(null);
  const connection = useRef<{ source: HTMLElement; dispose: () => void } | null>(null);
  // Switching conversations remounts the timeline under the same RefObject.
  useLayoutEffect(() => {
    const source = sourceRef.current, defs = defsRef.current;
    if (connection.current?.source === source) return;
    connection.current?.dispose();
    connection.current = null;
    if (source && defs) {
      const effect = createRegionalBlurFilter(defs);
      const disconnect = controller.connect(source, effect.filter, effect.mask);
      connection.current = { source, dispose: () => { disconnect(); effect.dispose(); } };
    }
  });
  useLayoutEffect(() => () => { connection.current?.dispose(); connection.current = null; }, []);
  return <RegionalBlurContext.Provider value={controllers}>
    <svg aria-hidden="true" width="0" height="0" style={{ position: 'absolute', pointerEvents: 'none' }}>
      <defs ref={defsRef} />
    </svg>
    {children}
  </RegionalBlurContext.Provider>;
}

export function useRegionalBlurSurface(enabled: boolean) {
  const controllers = useContext(RegionalBlurContext);
  return useCallback((element: HTMLElement | null) => {
    if (enabled && element) {
      const cleanups = controllers.map(controller => controller.register(element));
      return () => { for (const cleanup of cleanups.reverse()) cleanup(); };
    }
    return undefined;
  }, [controllers, enabled]);
}

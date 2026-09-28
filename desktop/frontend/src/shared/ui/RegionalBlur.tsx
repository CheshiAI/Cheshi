import { createContext, useCallback, useContext, useLayoutEffect, useMemo, useRef, useId, type ReactNode, type RefObject } from 'react';
import { createRegionalBlurController } from './regionalBlurController';

const RegionalBlurContext = createContext<ReturnType<typeof createRegionalBlurController> | null>(null);

/** Context crosses HTML portals, so floating menus share the composer's source and material. */
export function RegionalBlur({ sourceRef, children }: { sourceRef: RefObject<HTMLElement | null>; children: ReactNode }) {
  const id = `regional-blur-${useId().replace(/[^a-zA-Z0-9_-]/g, '')}`;
  const controller = useMemo(createRegionalBlurController, []);
  const filterRef = useRef<SVGFilterElement>(null);
  const maskRef = useRef<SVGFEImageElement>(null);
  const connection = useRef<{ source: HTMLElement; dispose: () => void } | null>(null);
  // Switching conversations remounts the timeline under the same RefObject.
  useLayoutEffect(() => {
    const source = sourceRef.current, filter = filterRef.current, mask = maskRef.current;
    if (connection.current?.source === source) return;
    connection.current?.dispose();
    connection.current = source && filter && mask ? { source, dispose: controller.connect(source, filter, mask) } : null;
  });
  useLayoutEffect(() => () => { connection.current?.dispose(); connection.current = null; }, []);
  return <RegionalBlurContext.Provider value={controller}>
    <svg aria-hidden="true" width="0" height="0" style={{ position: 'absolute', pointerEvents: 'none' }}>
      <defs>
        <filter ref={filterRef} id={id} filterUnits="userSpaceOnUse" primitiveUnits="userSpaceOnUse"
          x="0" y="0" colorInterpolationFilters="sRGB">
          <feGaussianBlur in="SourceGraphic" stdDeviation="4" result="blurred" />
          <feImage ref={maskRef} x="0" y="0" result="region" />
          <feComposite in="SourceGraphic" in2="region" operator="out" result="sharp" />
          <feComposite in="blurred" in2="region" operator="in" result="soft" />
          <feComposite in="sharp" in2="soft" operator="arithmetic" k2="1" k3="1" />
        </filter>
      </defs>
    </svg>
    {children}
  </RegionalBlurContext.Provider>;
}

export function useRegionalBlurSurface(enabled: boolean) {
  const controller = useContext(RegionalBlurContext);
  return useCallback((element: HTMLElement | null) => {
    if (enabled && controller && element) return controller.register(element);
    return undefined;
  }, [controller, enabled]);
}

import type { Ref } from 'react';

/** Forward an element and preserve both object refs and React callback-ref cleanup. */
export function attachElementRef<T>(ref: Ref<T> | undefined, element: T): () => void {
  if (typeof ref === 'function') {
    const cleanup = ref(element);
    return typeof cleanup === 'function' ? cleanup : () => { ref(null); };
  }
  if (ref) ref.current = element;
  return () => { if (ref) ref.current = null; };
}

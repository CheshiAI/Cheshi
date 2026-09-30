import { useEffect, useRef } from 'react';
import { mailboxKey } from '../../../../shared/apple-mail';
import type { MailModel, MailState } from './mailModel';

export function useMailInfiniteScroll(model: MailModel, state: MailState, active: boolean) {
  const viewportRef = useRef<HTMLDivElement>(null);
  const moreRef = useRef<HTMLDivElement>(null);
  const key = state.selectedBox ? mailboxKey(state.selectedBox) : null;
  useEffect(() => {
    if (viewportRef.current) viewportRef.current.scrollTop = 0;
  }, [key]);
  useEffect(() => {
    const root = viewportRef.current;
    const target = moreRef.current;
    const Observer = root?.ownerDocument.defaultView?.IntersectionObserver;
    if (!active || !root || !target || !Observer || state.page?.nextOffset == null
      || state.loadingBoxes || state.loadingPage || state.loadingMore || state.changing || state.moreError) return;
    let disposed = false;
    const observer = new Observer(entries => {
      if (!disposed && entries.some(entry => entry.isIntersecting)) void model.loadMore();
    }, { root, rootMargin: '240px 0px' });
    observer.observe(target);
    return () => { disposed = true; observer.disconnect(); };
  }, [model, active, state.page, state.loadingBoxes, state.loadingPage, state.loadingMore, state.changing, state.moreError]);
  return { viewportRef, moreRef };
}

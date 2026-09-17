import { safeShowcaseBackgroundColor, type ShowcaseApi, type ShowcasePage, type ShowcaseViewRequest } from '../../../../shared/showcase';
import { nativeBrowserViewportRequest, observeNativeBrowserViewport } from '../../shared/nativeBrowserViewport';

export function showcaseViewportRequest(element: HTMLElement, page: ShowcasePage): ShowcaseViewRequest {
  const backgroundColor = safeShowcaseBackgroundColor(window.getComputedStyle(element).getPropertyValue('--app-bg').trim());
  return { ...nativeBrowserViewportRequest(element), page, ...(backgroundColor === null ? {} : { backgroundColor }) };
}

export function observeShowcaseViewport(element: HTMLElement, api: ShowcaseApi, page: ShowcasePage,
  onError: (error: unknown) => void): () => void {
  return observeNativeBrowserViewport(element, element => showcaseViewportRequest(element, page),
    request => api.setView(request), onError);
}

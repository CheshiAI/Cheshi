import { lazy, StrictMode, Suspense } from 'react';
import { createRoot } from 'react-dom/client';

import App from './App';
import { cheshiDesktop } from './cheshiDesktop';
import { installWindowAppearance } from './features/settings/windowAppearance';
import { installSelectionCopy } from './shared/selectionCopy';
import './styles.css';

const TemporaryChatPanel = lazy(() => import('./features/chat/TemporaryChatPanel').then(module => ({ default: module.TemporaryChatPanel })));
const UsageTrayPopover = lazy(() => import('./features/account/UsageTrayPopover').then(module => ({ default: module.UsageTrayPopover })));
const StickyNotes = lazy(() => import('./features/sticky-notes/StickyNotes').then(module => ({ default: module.StickyNotes })));

const disposeAppearance = installWindowAppearance(cheshiDesktop?.appearance);
if (import.meta.hot) import.meta.hot.dispose(disposeAppearance);
const disposeSelectionCopy = installSelectionCopy(document);
if (import.meta.hot) import.meta.hot.dispose(disposeSelectionCopy);

const root = document.querySelector<HTMLDivElement>('#app');
if (!root) throw new Error('Missing application root.');
const usagePopover = window.cheshiUsagePopover;
const stickyNotes = window.cheshiStickyNotes;
if (stickyNotes) document.documentElement.dataset.stickyNotes = '';
const temporaryChat = new URLSearchParams(window.location.search).get('temporaryChat') === '1';
if (temporaryChat) document.documentElement.dataset.temporaryChat = '';
if (usagePopover) document.documentElement.dataset.usagePopover = '';

createRoot(root).render(
  <StrictMode>
    <Suspense fallback={null}>
      {stickyNotes ? <StickyNotes api={stickyNotes} /> : usagePopover ? <UsageTrayPopover api={usagePopover} /> : temporaryChat ? <TemporaryChatPanel /> : <App />}
    </Suspense>
  </StrictMode>,
);

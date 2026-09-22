import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import App from './App';
import { cheshiDesktop } from './cheshiDesktop';
import { installWindowAppearance } from './features/settings/windowAppearance';
import { UsageTrayPopover } from './features/account/UsageTrayPopover';
import { installSelectionCopy } from './shared/selectionCopy';
import './styles.css';

const disposeAppearance = installWindowAppearance(cheshiDesktop?.appearance);
if (import.meta.hot) import.meta.hot.dispose(disposeAppearance);
const disposeSelectionCopy = installSelectionCopy(document);
if (import.meta.hot) import.meta.hot.dispose(disposeSelectionCopy);

const root = document.querySelector<HTMLDivElement>('#app');
if (!root) throw new Error('Missing application root.');
const usagePopover = window.cheshiUsagePopover;
if (usagePopover) document.documentElement.dataset.usagePopover = '';

createRoot(root).render(
  <StrictMode>
    {usagePopover ? <UsageTrayPopover api={usagePopover} /> : <App />}
  </StrictMode>,
);

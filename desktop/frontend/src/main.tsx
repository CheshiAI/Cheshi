import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import App from './App';
import { installSelectionCopy } from './shared/selectionCopy';
import './styles.css';

const disposeSelectionCopy = installSelectionCopy(document);
if (import.meta.hot) import.meta.hot.dispose(disposeSelectionCopy);

const root = document.querySelector<HTMLDivElement>('#app');
if (!root) throw new Error('Missing application root.');

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

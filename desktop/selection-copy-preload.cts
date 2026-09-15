import { ipcRenderer } from 'electron';
import { installDragCopy } from './shared/drag-copy.ts';

// Isolated world only: external pages receive no callable Electron API.
installDragCopy(document, text => ipcRenderer.send('cheshi:copy-drag-selection', text));

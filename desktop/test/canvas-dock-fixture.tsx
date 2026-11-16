import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import type { CanvasApi, CanvasDocument } from '../shared/canvas';
import { SidebarTabs } from '../frontend/src/shared/ui/SidebarTabs';
import { OverlayScrollArea } from '../frontend/src/shared/ui/OverlayScrollArea';
import '../frontend/src/styles.css';
import './canvas-dock-fixture.css';

const base = document.createElement('base');
base.href = new URL('../', new URLSearchParams(location.search).get('editor')!).href;
document.head.append(base);
const documents = new Map<string, CanvasDocument>();
const api: CanvasApi = {
  lastDocument: async () => null, rememberDocument: async () => {},
  list: async () => ({ workspaceRoot: '/fixture', canvasRoot: 'designs', historyDirectory: '/fixture/history', truncated: false,
    files: Array.from({ length: 60 }, (_, index) => ({ path: `designs/${index === 0 ? 'one' : index === 1 ? 'two' : `file-${index}`}.fig`, size: 1, modifiedAt: 1 })) }),
  read: async path => { const item = documents.get(path); if (!item) throw Error('Missing fixture document'); return item; },
  save: async request => { documents.set(request.path, { ...request, revision: 'saved' }); return { path: request.path, revision: 'saved' }; },
  chooseRoot: async () => null, newPath: async name => `designs/${name}.fig`,
  rename: async () => { throw Error('Unexpected rename'); },
  history: async path => ({ path, currentRevision: null, versions: [] }),
  readVersion: async () => { throw Error('Unexpected history read'); },
  checkpoint: async () => { throw Error('Unexpected checkpoint'); },
  restore: async () => { throw Error('Unexpected restore'); },
};
Object.defineProperty(window, 'cheshiDesktop', { value: { canvas: api, onWorkspaceFilesChanged: () => () => {} } });
const { OriginalCanvasEditor } = await import('../frontend/src/features/canvas/integration/OriginalCanvasEditor');

function Fixture() {
  const [sidebar, setSidebar] = useState<HTMLDivElement | null>(null);
  const [active, setActive] = useState(true);
  const [sidebarVisible, setSidebarVisible] = useState(true);
  const [target, setTarget] = useState<{ path: string; requestId: number } | null>(null);
  const [mounted, setMounted] = useState(true);
  const [panel, setPanel] = useState('canvas');
  const [selected, setSelected] = useState('');
  const list = (name: string) => <OverlayScrollArea className="fixture-list" label={name}>
    {Array.from({ length: 80 }, (_, index) => <button key={index} data-fixture-row={`${name}-${index}`}
      aria-pressed={selected === `${name}-${index}`} onClick={() => setSelected(`${name}-${index}`)}>{name} {index}</button>)}
  </OverlayScrollArea>;
  return <><nav>
    <button data-toggle-active onClick={() => setActive(value => !value)}>Toggle Canvas</button>
    <button data-toggle-sidebar onClick={() => setSidebarVisible(value => !value)}>Toggle sidebar</button>
    <button data-unmount onClick={() => setMounted(false)}>Unmount</button>
  </nav><div className="app-layout fixture-workspace">
    <aside hidden={!sidebarVisible} className="fixture-sidebar">
      <SidebarTabs activeId={panel} onSelect={setPanel} tabs={[
        { id: 'canvas', label: 'CANVAS', content: <div ref={setSidebar} className="sidebar-content-primary" /> },
        { id: 'files', label: 'EXPLORER', content: list('Explorer') },
        { id: 'chats', label: 'SESSION', content: list('Sessions') },
        { id: 'memos', label: 'MEMO', content: list('Memos') },
      ]} />
    </aside>
    <div className="fixture-editor">{mounted && <OriginalCanvasEditor active={active} target={target} sidebarTarget={sidebar}
      onOpenFile={path => setTarget({ path, requestId: Date.now() })} onDirtyChange={() => {}} />}</div>
  </div></>;
}
createRoot(document.getElementById('root')!).render(<Fixture />);

import { ChevronDown, FileText } from 'lucide-react';

import { draggableWindowRegionStyle, nonDraggableWindowRegionStyle } from '../../shared/ui';

const tabs = [
  { name: 'AGENTS.md', active: true },
  { name: 'package.json', active: false },
  { name: 'More…', active: false },
];

export function WindowTabs() {
  return (
    <nav className="window-tabs" aria-label="Open files" style={draggableWindowRegionStyle}>
      {tabs.map((tab) => (
        <button className={`window-tab${tab.active ? ' active' : ''}`} key={tab.name} type="button" style={nonDraggableWindowRegionStyle}>
          <FileText aria-hidden="true" />
          <span>{tab.name}</span>
          {tab.active && <ChevronDown aria-hidden="true" className="window-tab-chevron" />}
        </button>
      ))}
    </nav>
  );
}

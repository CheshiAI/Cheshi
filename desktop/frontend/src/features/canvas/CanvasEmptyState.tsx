import { useContext } from 'react';
import { Frame } from 'lucide-react';
import { EmptyState, SidebarPanelHeader } from '../../shared/ui';
import { CheshiLogoEffect } from '../../shared/ui/CheshiLogoEffect';
import { useHelpLanguage } from '../../shared/useHelpLanguage';
import { WorkspacePaneVisibilityContext } from '../shell/WorkspaceLayoutControls';
import styles from './integration/OriginalCanvasEditor.module.css';

export function CanvasEmptyState({ active }: { active: boolean }) {
  const [language] = useHelpLanguage();
  const visible = useContext(WorkspacePaneVisibilityContext);
  return <div className={styles.emptyWorkspace} aria-label="Canvas start">
    <SidebarPanelHeader title="CANVAS" icon={<Frame aria-hidden="true" />} />
    <CheshiLogoEffect active={active && visible}>
      <EmptyState variant="section" title="Canvas"
        description={language === 'ko' ? '왼쪽에서 캔버스를 선택하세요.' : 'Select a canvas from the sidebar.'} />
    </CheshiLogoEffect>
  </div>;
}

export function CanvasLoadingState({ active }: { active: boolean }) {
  return <section className={styles.workspace} hidden={!active} inert={!active} aria-label="Canvas" aria-busy="true">
    <CanvasEmptyState active={active} />
  </section>;
}

import { useContext } from 'react';
import { CheshiLogoEffect } from '../../shared/ui/CheshiLogoEffect';
import { WorkspacePaneVisibilityContext } from '../shell/WorkspaceLayoutControls';

export function ChatWelcome() {
  const visible = useContext(WorkspacePaneVisibilityContext);
  return <CheshiLogoEffect active={visible} />;
}

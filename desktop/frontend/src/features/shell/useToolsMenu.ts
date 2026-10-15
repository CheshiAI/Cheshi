import { useEffect, useRef } from 'react';
import { cheshiDesktop } from '../../cheshiDesktop';
import type { WorkspaceManagementApi } from '../../../../shared/workspace-management';

export function useToolsMenu(navigate: (view: 'codegraph' | 'voice') => void,
  api: Pick<WorkspaceManagementApi, 'onRelationshipGraphRequested' | 'onVoiceRequested'> | undefined = cheshiDesktop?.workspaceManagement) {
  const current = useRef(navigate);
  current.current = navigate;
  useEffect(() => {
    const removeGraph = api?.onRelationshipGraphRequested?.(() => current.current('codegraph'));
    const removeVoice = api?.onVoiceRequested?.(() => current.current('voice'));
    return () => { removeGraph?.(); removeVoice?.(); };
  }, [api]);
}

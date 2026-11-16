import { useEffect, useRef } from 'react';
import { cheshiDesktop } from '../../cheshiDesktop';
import type { WorkspaceManagementApi } from '../../../../shared/workspace-management';

export function useToolsMenu(navigate: (view: 'codegraph') => void,
  api: Pick<WorkspaceManagementApi, 'onRelationshipGraphRequested'> | undefined = cheshiDesktop?.workspaceManagement) {
  const current = useRef(navigate);
  current.current = navigate;
  useEffect(() => {
    const removeGraph = api?.onRelationshipGraphRequested?.(() => current.current('codegraph'));
    return () => { removeGraph?.(); };
  }, [api]);
}

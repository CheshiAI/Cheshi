import type { CodeGraph } from '../../src';
import type { ToolHandler } from '../../src/mcp/tools';
import type { ToolHandlerState } from '../../src/mcp/tool-handler-state';
import type { CodeGraphState } from '../../src/project-state';
import type { ReferenceResolver } from '../../src/resolution';
import type { ResolverState } from '../../src/resolution/resolver-state';

// Integration tests deliberately inspect storage and inject recovery failures.
// Keep their access to private implementation state at this single boundary.
export function getCodeGraphState(graph: CodeGraph): CodeGraphState {
  return (graph as unknown as { state: CodeGraphState }).state;
}

export function getResolverState(resolver: ReferenceResolver): ResolverState {
  return (resolver as unknown as { state: ResolverState }).state;
}

export function getToolHandlerState(handler: ToolHandler): ToolHandlerState {
  return (handler as unknown as { state: ToolHandlerState }).state;
}

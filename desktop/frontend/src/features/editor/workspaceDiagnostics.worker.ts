import { analyzeTomlSource } from './tomlDiagnostics';
import { analyzeTypeScriptSource } from './typescriptDiagnostics';
import type {
  WorkspaceDiagnosticsWorkerRequest,
  WorkspaceDiagnosticsWorkerResponse,
} from './workspaceDiagnostics';

const workerScope = globalThis as unknown as {
  onmessage: ((event: MessageEvent<WorkspaceDiagnosticsWorkerRequest>) => void) | null;
  postMessage: (message: WorkspaceDiagnosticsWorkerResponse) => void;
};

workerScope.onmessage = (event): void => {
  const { requestId, path, content, engine } = event.data;
  try {
    const diagnostics = engine === 'toml'
      ? analyzeTomlSource(content)
      : analyzeTypeScriptSource(path, content);

    workerScope.postMessage({
      requestId,
      path,
      diagnostics,
    });
  } catch (error) {
    workerScope.postMessage({
      requestId,
      path,
      error: error instanceof Error ? error.message : String(error),
    });
  }
};

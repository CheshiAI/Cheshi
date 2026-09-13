export type ChatHistoryItemKind = 'user' | 'assistant' | 'activity' | 'plan';
export type ChatHistoryFileReference = { path: string; kind: 'mentioned' | 'changed' | 'read' };

export interface ChatHistorySearchRequest {
  query: string;
  filePath?: string;
  refresh?: boolean;
  limit?: number;
}

export interface ChatHistorySearchHit {
  threadId: string;
  turnId: string;
  itemId: string;
  title: string;
  snippet: string;
  kind: ChatHistoryItemKind;
  updatedAt: number;
  files: ChatHistoryFileReference[];
  /** Additional fork copies of the same source item, not repeated prose. */
  duplicateCount: number;
}

export interface ChatHistorySearchResponse {
  hits: ChatHistorySearchHit[];
  total: number;
  indexedSessions: number;
  unavailableSessions: string[];
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

export function chatHistorySearchRequest(value: unknown): Required<ChatHistorySearchRequest> {
  const request = record(value);
  if (!request || typeof request.query !== 'string' || request.query.length > 500
    || (request.filePath !== undefined && (typeof request.filePath !== 'string' || request.filePath.length > 4096))
    || (request.refresh !== undefined && request.refresh !== true && request.refresh !== false)
    || (request.limit !== undefined && (typeof request.limit !== 'number' || !Number.isInteger(request.limit)
      || request.limit < 1 || request.limit > 100))) {
    throw new TypeError('Invalid chat history search request.');
  }
  const query = request.query.trim();
  const filePath = typeof request.filePath === 'string' ? request.filePath.trim() : '';
  if (!query && !filePath) throw new TypeError('Enter search text or a workspace file path.');
  return { query, filePath, refresh: request.refresh === true, limit: typeof request.limit === 'number' ? request.limit : 50 };
}

export function isChatHistoryItemKind(value: unknown): value is ChatHistoryItemKind {
  return value === 'user' || value === 'assistant' || value === 'activity' || value === 'plan';
}

export function isChatHistoryFileReferences(value: unknown): value is ChatHistoryFileReference[] {
  return Array.isArray(value) && value.every(file => {
    const entry = record(file);
    return entry && typeof entry.path === 'string' && entry.path.length > 0
      && (entry.kind === 'mentioned' || entry.kind === 'changed' || entry.kind === 'read');
  });
}

function isCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

export function chatHistorySearchResponse(value: unknown): ChatHistorySearchResponse {
  const response = record(value);
  if (!response || !Array.isArray(response.hits) || response.hits.length > 100
    || !isCount(response.total) || response.total < response.hits.length || !isCount(response.indexedSessions)
    || !Array.isArray(response.unavailableSessions) || response.unavailableSessions.some(id => typeof id !== 'string')
    || response.hits.some(value => {
      const hit = record(value);
      return !hit || ['threadId', 'turnId', 'itemId', 'title', 'snippet'].some(key => typeof hit[key] !== 'string')
        || !hit.threadId || !hit.turnId || !hit.itemId || !isChatHistoryItemKind(hit.kind)
        || typeof hit.updatedAt !== 'number' || !Number.isFinite(hit.updatedAt)
        || !isCount(hit.duplicateCount) || !isChatHistoryFileReferences(hit.files);
    })) throw new TypeError('Invalid chat history search response.');
  return response as unknown as ChatHistorySearchResponse;
}

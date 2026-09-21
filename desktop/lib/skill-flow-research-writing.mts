import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { ResearchActions, ResearchDocument, ResearchRequest } from './skill-flow-research.mts';
import { assertResearch, ResearchValidationError, type ResearchIssue } from './skill-flow-research-validation.mts';

export interface ResearchWriteFeedback { issues: ResearchIssue[]; previousDraft?: string }
const MAX_DRAFT_BYTES = 64_000;

function snapshot(draft: unknown) {
  let content: string;
  try { content = typeof draft === 'string' ? draft : JSON.stringify(draft) ?? '[unserializable]'; }
  catch { content = '[unserializable]'; }
  const buffer = Buffer.from(content);
  return { format: typeof draft === 'string' ? 'text' : 'json',
    content: buffer.subarray(0, MAX_DRAFT_BYTES).toString('utf8'), truncated: buffer.length > MAX_DRAFT_BYTES };
}

function parsedDraft(draft: unknown): unknown {
  if (typeof draft !== 'string') return draft;
  assertResearch(Buffer.byteLength(draft) <= MAX_DRAFT_BYTES, 'output_limit', 'response');
  try { return JSON.parse(draft); }
  catch { throw new ResearchValidationError('invalid_json', 'response'); }
}

/** Initial writing plus at most two repairs; provider errors and cancellation never become repair attempts. */
export async function writeResearchDocument(request: ResearchRequest, actions: ResearchActions, directory: string,
  validate: (draft: unknown) => Promise<ResearchDocument>, signal?: AbortSignal): Promise<ResearchDocument> {
  let feedback: ResearchWriteFeedback | undefined;
  for (let attempt = 1; attempt <= 3; attempt++) {
    signal?.throwIfAborted();
    const filename = path.join(directory, `writing-${attempt}.json`);
    const save = (value: Record<string, unknown>) => writeFile(filename, JSON.stringify({ attempt, ...value }, null, 2),
      { encoding: 'utf8' as const, flag: 'wx', mode: 0o600 });
    let draft: unknown;
    try { draft = await actions.write(request, signal, feedback); }
    catch (error) {
      await save({ status: signal?.aborted ? 'canceled' : 'provider_error' });
      throw error;
    }
    signal?.throwIfAborted();
    const captured = snapshot(draft);
    let document: ResearchDocument;
    try {
      assertResearch(!captured.truncated, 'output_limit', 'response');
      document = await validate(parsedDraft(draft));
    } catch (error) {
      const issue = error instanceof ResearchValidationError ? error.issue : null;
      await save({ status: signal?.aborted ? 'canceled' : issue ? 'rejected' : 'validation_interrupted',
        draft: captured, issues: issue ? [issue] : [] });
      signal?.throwIfAborted();
      if (!issue || attempt === 3) throw error;
      // Do not send truncated or excessively large drafts back as if they were the original response.
      feedback = { issues: [issue], ...(!captured.truncated && Buffer.byteLength(captured.content) <= 18_000
        ? { previousDraft: captured.content } : {}) };
      continue;
    }
    signal?.throwIfAborted();
    await save({ status: 'accepted', draft: captured, issues: [] });
    return document;
  }
  throw new ResearchValidationError('invalid_shape', 'response');
}

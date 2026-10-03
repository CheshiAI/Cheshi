import { join } from 'node:path';
import { appendOutgoing, identifier, type CollaborationMessage } from './collaboration-contract.ts';
import { record, textValue, type JsonRecord } from './protocol.ts';
import { AgentStore, type Task } from './store.ts';
import { captureWork, WorkFiles, workDigest } from './work-files.ts';
import { assertWorkResult, parseWorkRequest, parseWorkResult, parseWorkReview, workPath, workSnapshotText, type WorkRequest, type WorkResult } from './work-contract.ts';

export class WorkerWork {
  private readonly store: AgentStore;
  private readonly workspace: string;
  private readonly agentId: string;
  private readonly fileWrite: boolean;
  constructor(store: AgentStore, workspace: string, agentId: string, fileWrite: boolean) {
    this.store = store; this.workspace = workspace; this.agentId = agentId; this.fileWrite = fileWrite;
  }
  request(task: Task): CollaborationMessage {
    const request = this.store.snapshot().collaboration.incoming.find(m => m.id === task.delegation && m.kind === 'work_request');
    if (!request || request.to !== this.agentId || request.roomId !== task.roomId) throw new Error('Original delegated work is unavailable.');
    return request;
  }
  files(task: Task, existing = false): WorkFiles {
    const request = this.request(task);
    return new WorkFiles(join(this.store.directory, 'work'), request.id, parseWorkRequest(JSON.parse(request.text)), existing);
  }
  assertWritable(task: Task): void {
    const request = this.request(task), c = this.store.snapshot().collaboration;
    if (!this.fileWrite || !c.peers.some(p => p.id === request.from && p.fileWrite === true)
      || !request.roomId || !c.rooms?.[request.roomId]?.includes(this.agentId) || !c.rooms[request.roomId]?.includes(request.from)) {
      throw new Error('Delegated work requires both participants to retain file-write permission and room membership.');
    }
  }
  assertReviewed(task: Task): void {
    const c = this.store.snapshot().collaboration;
    const requests = c.outgoing.filter(m => m.kind === 'work_request' && m.taskId === task.id);
    for (const request of requests) {
      if (requests.some(m => parseWorkRequest(JSON.parse(m.text)).previousRequestId === request.id)) continue;
      const review = c.outgoing.find(m => m.kind === 'work_review' && m.questionId === request.id);
      if (!review || parseWorkReview(JSON.parse(review.text)).decision !== 'accepted') throw new Error('Review every delegated proposal before completing the goal. Accepted proposals still require integration and independent verification.');
    }
  }
  call(task: Task, tool: string, value: unknown): JsonRecord {
    const args = record(value), c = this.store.snapshot().collaboration;
    if (tool === 'request_work') return this.enqueue(task, args);
    if (tool === 'work_status') return {
      requests: c.outgoing.filter(m => m.kind === 'work_request' && m.taskId === task.id).map(m => {
        const request = parseWorkRequest(JSON.parse(m.text));
        return { id: m.id, to: m.to, objective: request.objective, criteria: request.criteria, writePaths: request.writePaths, snapshot: request.snapshot };
      }),
      results: c.incoming.filter(m => m.kind === 'work_result' && m.taskId === task.id).map(m => ({ requestId: m.questionId, ...parseWorkResult(JSON.parse(m.text)) })),
      reviews: c.outgoing.filter(m => m.kind === 'work_review' && m.taskId === task.id).map(m => ({ requestId: m.questionId, ...parseWorkReview(JSON.parse(m.text)) })),
    };
    if (tool === 'review_work') {
      if (!task.goal || task.delegation) throw new Error('Only the owning goal can review work.');
      const request = c.outgoing.find(m => m.kind === 'work_request' && m.id === args.requestId && m.taskId === task.id);
      const result = request && c.incoming.find(m => m.kind === 'work_result' && m.questionId === request.id);
      if (!request || !result) throw new Error('Wait for the delegated result before reviewing it.');
      const review = parseWorkReview({ version: 1, decision: args.decision, feedback: args.feedback });
      if (review.decision === 'accepted' && parseWorkResult(JSON.parse(result.text)).status !== 'submitted') throw new Error('Only submitted work can be accepted.');
      const message: CollaborationMessage = { ...request, id: workDigest(`review/${request.id}`), kind: 'work_review', text: JSON.stringify(review) };
      this.store.transaction(state => appendOutgoing(state.collaboration, message));
      return { requestId: request.id, decision: review.decision, appliedToProject: false };
    }
    if (!task.delegation) throw new Error('This tool requires delegated work.');
    this.assertWritable(task);
    if (task.workDraft) throw new Error('End the turn after submitting work.');
    const files = this.files(task, true);
    if (tool === 'work_read') return { ...files.read(workPath(args.path)) };
    if (tool === 'work_write') {
      if (args.content !== null && typeof args.content !== 'string') throw new Error('Expected text or null to delete a file.');
      return { ...files.write(workPath(args.path), args.content as string | null) };
    }
    if (tool === 'submit_work') {
      const result = files.result(textValue(args.summary, 'work summary'));
      this.store.update(task.id, { workDraft: { summary: result.summary, digest: workDigest(JSON.stringify(result)) } });
      return { status: 'recorded', changes: result.changes.map(({ path, before, sha256 }) => ({ path, before, sha256 })),
        guidance: 'End the turn now. This is a proposed change, not independent verification or integration.' };
    }
    throw new Error('Unsupported delegated work tool.');
  }
  private enqueue(task: Task, args: JsonRecord): JsonRecord {
    if (!this.fileWrite || !task.goal || !task.roomId || task.delegation || task.consultation || task.verification) throw new Error('Only a writable room goal can delegate implementation.');
    const c = this.store.snapshot().collaboration, target = identifier(args.agentId), requestId = identifier(args.requestId);
    if (!c.rooms?.[task.roomId]?.includes(this.agentId) || !c.rooms[task.roomId]?.includes(target)
      || target === this.agentId || !c.peers.some(p => p.id === target && p.fileWrite === true && p.workProtocol === 1)) throw new Error('Choose an invited, updated peer with file-write permission.');
    const paths = (value: unknown) => {
      if (!Array.isArray(value) || !value.length || value.length > 32) throw new Error('Choose 1–32 exact files.');
      return [...new Set(value.map(workPath))].sort();
    };
    const input = { objective: textValue(args.objective, 'objective'), criteria: args.criteria as string[],
      paths: paths(args.paths), writePaths: paths(args.writePaths), previousRequestId: args.previousRequestId === null ? null : identifier(args.previousRequestId) };
    const id = workDigest(`work/${this.agentId}/${task.id}/${requestId}`), previous = c.outgoing.find(m => m.id === id);
    if (previous) {
      const saved = parseWorkRequest(JSON.parse(previous.text));
      if (previous.to !== target || saved.objective !== input.objective || JSON.stringify(saved.criteria) !== JSON.stringify(input.criteria)
        || JSON.stringify(saved.writePaths) !== JSON.stringify(input.writePaths) || saved.previousRequestId !== input.previousRequestId
        || JSON.stringify(saved.files.map(f => f.path)) !== JSON.stringify([...new Set([...input.paths, ...input.writePaths])].sort())) throw new Error('Work request identity conflict.');
      return { requestId: id, status: 'queued', snapshot: saved.snapshot };
    }
    let request: WorkRequest;
    if (input.previousRequestId) {
      const prior = c.outgoing.find(m => m.id === input.previousRequestId && m.taskId === task.id && m.kind === 'work_request' && m.to === target);
      const reply = prior && c.incoming.find(m => m.kind === 'work_result' && m.questionId === prior.id);
      const review = prior && c.outgoing.find(m => m.kind === 'work_review' && m.questionId === prior.id);
      if (!prior || !reply || !review || parseWorkReview(JSON.parse(review.text)).decision !== 'changes_requested') throw new Error('Review the prior result before requesting a revision.');
      const baseline = parseWorkRequest(JSON.parse(prior.text)), result = parseWorkResult(JSON.parse(reply.text));
      if (input.writePaths.some(p => !baseline.writePaths.includes(p)) || input.paths.some(p => !baseline.files.some(f => f.path === p))) throw new Error('A revision cannot expand the original file scope.');
      const files = baseline.files.map(f => { const change = result.changes.find(ch => ch.path === f.path); return change ? { path: change.path, content: change.content, sha256: change.sha256 } : f; })
        .filter(f => input.paths.includes(f.path) || input.writePaths.includes(f.path));
      request = parseWorkRequest({ ...input, version: 1, files, snapshot: workDigest(workSnapshotText(files)) });
    } else request = captureWork(this.workspace, input);
    const message: CollaborationMessage = { id, kind: 'work_request', questionId: id, from: this.agentId, to: target, taskId: task.id, roomId: task.roomId, text: JSON.stringify(request) };
    this.store.transaction(state => appendOutgoing(state.collaboration, message));
    return { requestId: id, status: 'queued', snapshot: request.snapshot, guidance: 'Continue independent work; wait when only peer results remain.' };
  }
  resultMessage(task: Task, execution: string, explanation: string): CollaborationMessage {
    const request = this.request(task), spec = parseWorkRequest(JSON.parse(request.text));
    const previous = this.store.snapshot().collaboration.outgoing.find(m => m.kind === 'work_result' && m.questionId === request.id);
    if (previous) { assertWorkResult(spec, parseWorkResult(JSON.parse(previous.text)), workDigest); return previous; }
    let result: WorkResult = { version: 1, snapshot: spec.snapshot, status: execution === 'failed' ? 'failed' : execution === 'interrupted' ? 'cancelled' : 'blocked',
      summary: explanation.slice(0, 4000) || 'No submitted work result. Request a new attempt after reviewing the task.', changes: [] };
    if (execution === 'completed' && task.workDraft) {
      result = this.files(task, true).result(task.workDraft.summary);
      if (workDigest(JSON.stringify(result)) !== task.workDraft.digest) throw new Error('Submitted work changed before collection. Inspect this execution.');
    }
    assertWorkResult(spec, result, workDigest);
    return { ...request, id: workDigest(`work-result/${request.id}`), kind: 'work_result', from: this.agentId, to: request.from, text: JSON.stringify(result) };
  }
}

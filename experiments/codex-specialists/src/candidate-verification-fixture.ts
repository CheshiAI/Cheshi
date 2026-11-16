import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { AgentStore } from './store.ts';
import { WorkerCollaboration } from './collaboration.ts';
import { WorkerWork } from './work.ts';
import { WorkerIntegration } from './integration.ts';
import { WorkerVerification } from './verification.ts';
import { WorkFiles, workDigest } from './work-files.ts';
import { parseWorkRequest } from './work-contract.ts';
import { newGoal } from './decision.ts';

/** Real stores and file snapshots; the caller owns the temporary root's lifecycle. */
export function candidateFixture(root: string, count = 3) {
  const project = join(root, 'project'); mkdirSync(project);
  const paths = Array.from({ length: count }, (_, i) => `file-${String(i).padStart(2, '0')}.txt`);
  for (const path of paths) writeFileSync(join(project, path), `original ${path}`);
  const roster = [
    { id: 'owner', name: 'Owner', role: 'development', fileWrite: true, workProtocol: 1 as const },
    { id: 'author', name: 'Author', role: 'verification', fileWrite: true, workProtocol: 1 as const },
    { id: 'verifier', name: 'Verifier', role: 'verification', fileWrite: false, workProtocol: 1 as const },
  ];
  const rooms = { room: roster.map(p => p.id) };
  const store = new AgentStore(join(root, 'owner')), reviewer = new AgentStore(join(root, 'reviewer'));
  const owner = new WorkerCollaboration(store, 'owner', project), peer = new WorkerCollaboration(reviewer, 'verifier', project);
  const work = new WorkerWork(store, project, 'owner', true), integration = new WorkerIntegration(store, project, 'owner', true);
  const verifier = new WorkerVerification(reviewer, project);
  owner.exchange({ peers: roster, rooms, messages: [], acknowledged: [] });
  const task = store.create('goal', 'Integrate and verify scoped files', { roomId: 'room', goal: newGoal(true), conversation: 'goal' });
  const id = String(work.call(task, 'request_work', { agentId: 'author', requestId: 'work', objective: 'Update snapshot', criteria: ['Files updated'], paths, writePaths: paths, previousRequestId: null }).requestId);
  const request = store.snapshot().collaboration.outgoing.find(m => m.id === id)!;
  const files = new WorkFiles(join(root, 'author'), id, parseWorkRequest(JSON.parse(request.text)));
  for (const [i, path] of paths.entries()) files.write(path, i === 1 ? null : `candidate ${path}`);
  owner.exchange({ peers: roster, rooms, messages: [{ ...request, id: workDigest(`result/${id}`), from: 'author', to: 'owner', kind: 'work_result', text: JSON.stringify(files.result('Updated files')) }], acknowledged: [] });
  work.call(task, 'review_work', { requestId: id, decision: 'accepted', feedback: 'Accepted for independent verification' });
  integration.call(task, 'prepare_integration', { requestId: 'candidate', requestIds: [id] });
  const candidate = integration.snapshot(store.task('goal')!);
  const args = { agentId: 'verifier', requestId: 'verify', criteria: ['Candidate is correct'], paths };
  const inspect = () => integration.inspect(store.task('goal')!)!;
  function requestVerification() {
    owner.call(store.task('goal')!, 'request_verification', args, candidate);
    const message = store.snapshot().collaboration.outgoing.at(-1)!;
    peer.exchange({ peers: roster, rooms, messages: [message], acknowledged: [] });
    const next = peer.next()!;
    reviewer.create(next.taskId, next.prompt, { verification: next.verification, roomId: next.roomId, conversation: next.taskId });
    const cwd = verifier.workspaceFor(reviewer.task(next.taskId)!, false);
    return { message, taskId: next.taskId, cwd };
  }
  function observe(taskId: string, exitCode = 0) {
    const item = { id: 'native-command', type: 'commandExecution', command: 'test candidate', status: 'completed', exitCode, aggregatedOutput: 'Checked candidate' };
    verifier.observe(reviewer.task(taskId)!, 'item/started', item); verifier.observe(reviewer.task(taskId)!, 'item/completed', item);
  }
  function draft(taskId: string, verdict: 'pass' | 'fail' | 'inconclusive' = 'pass') {
    for (const path of paths) verifier.call(reviewer.task(taskId)!, 'verification_read', { path });
    const evidenceIds = reviewer.task(taskId)!.verificationEvidence!.slice(0, 2).map(e => e.id);
    verifier.call(reviewer.task(taskId)!, 'submit_verification', { verdicts: [{ criterion: args.criteria[0], verdict, reason: 'Checked actual candidate', evidenceIds }] });
  }
  function deliver(taskId: string) {
    peer.publishVerification(reviewer.task(taskId)!, verifier.finish(reviewer.task(taskId)!));
    const message = reviewer.snapshot().collaboration.outgoing.at(-1)!;
    owner.exchange({ peers: roster, rooms, messages: [message], acknowledged: [] });
    return message;
  }
  return { project, paths, store, reviewer, owner, peer, work, integration, verifier, candidate, args, roster, rooms, inspect, requestVerification, observe, draft, deliver };
}

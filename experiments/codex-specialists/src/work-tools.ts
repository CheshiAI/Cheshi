const text = { type: 'string' }, paths = { type: 'array', minItems: 1, maxItems: 32, items: text };
const tool = (name: string, description: string, properties: Record<string, unknown>) => ({ type: 'function', name, description,
  inputSchema: { type: 'object', properties, required: Object.keys(properties), additionalProperties: false } });
export const workTools = [
  tool('request_work', 'Delegate bounded implementation to an invited writable peer. Capture only the listed exact UTF-8 files; writePaths must name exact files, including new files. Reuse requestId only for identical retries. previousRequestId is null for new work, or a previously reviewed request needing revision. No automatic project integration.',
    { agentId: text, requestId: text, objective: text, criteria: { ...paths, maxItems: 16 }, paths, writePaths: paths, previousRequestId: { type: ['string', 'null'] } }),
  tool('work_status', 'Read this goal’s work requests, proposed file contents and reviews. Submitted work is not applied or independently verified.', {}),
  tool('review_work', 'Accept a submitted proposal for later integration or request changes. This never applies files. To revise, call request_work with a new requestId and the previousRequestId.',
    { requestId: text, decision: { enum: ['accepted', 'changes_requested'] }, feedback: text }),
  tool('work_read', 'Read an exact file from the current delegated snapshot.', { path: text }),
  tool('work_write', 'Replace an authorized snapshot text file, or delete it with null. Original project files are never changed.', { path: text, content: { type: ['string', 'null'] } }),
  tool('submit_work', 'Collect actual snapshot changes for review. End the turn after this call. File hashes and content are collected by the worker, not supplied by the model.', { summary: text }),
];
export const workInstructions = `
Implementation delegation is available through request_work for writable room goals and writable invited peers.
Use ask_agent only for consultation; use request_work for file changes. Keep the delegated objective and paths within the user-approved scope.
Specify exact text files for context and exact writePaths; new files may be absent. Dependencies not included in the snapshot are not installed automatically.
Continue independent work while a peer works, or record wait when only results remain. Do not poll.
Use work_status to inspect returned changes and review_work to accept a proposal or request changes.
Acceptance records review only. Work results do not directly change the project; use the configured integration and verification flow for application. Do not claim an implementation has been integrated or verified based on submission.
For revisions, review with changes_requested and send a new request_work referencing previousRequestId. The prior result becomes the new isolated baseline without expanding file scope.
For delegated tasks, edit only with work_write and read with work_read. Commands, when enabled, have read-only snapshot access and a disposable scratch directory. Never change the original project or start another delegation.
Call submit_work as the last tool call, then end the turn. If blocked, explain why; the result is not a success.
`;

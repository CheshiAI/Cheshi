import { record } from './protocol.ts';

// Keep this worker-safe schema aligned with the SESSION contract. The parity test
// compares every property, default, enum and required argument with CodeGraph.
const text = { type: 'string' };
const number = { type: 'number' };
const definition = (name: string, description: string, properties: Record<string, unknown>, required: string[]) => ({
  type: 'function', name, description,
  inputSchema: { type: 'object', properties, required, additionalProperties: false },
});
export const codegraphTools = [
  definition('codegraph_explore', 'Explore relevant source and call relationships in the assigned project. maxFiles defaults to 12. Read-only; check stale results against current files.', { query: text, maxFiles: { ...number, default: 12 } }, ['query']),
  definition('codegraph_search', 'Search symbols in the assigned project index. limit defaults to 10.', { query: text, kind: { ...text, enum: ['function', 'method', 'class', 'interface', 'type', 'variable', 'route', 'component'] }, limit: { ...number, default: 10 } }, ['query']),
  definition('codegraph_node', "Read a file or symbol with source and dependencies. File paths are relative to /workspace. offset is a 1-based line; limit is the number of lines. Omit limit for CodeGraph's default. symbolsOnly returns the symbol map; line disambiguates symbol definitions.", { symbol: text, file: text, includeCode: { type: 'boolean', default: false }, offset: number, limit: number, symbolsOnly: { type: 'boolean', default: false }, line: number }, []),
  ...['callers', 'callees'].map(kind => definition(`codegraph_${kind}`, `Read ${kind} of a symbol. limit defaults to 20.`, { symbol: text, file: text, limit: { ...number, default: 20 } }, ['symbol'])),
  definition('codegraph_impact', 'Read dependencies affected by a symbol. depth defaults to 2.', { symbol: text, file: text, depth: { ...number, default: 2 } }, ['symbol']),
];
export function codegraphArguments(tool: string, value: unknown): Record<string, unknown> {
  const spec = codegraphTools.find(t => t.name === tool);
  if (!spec) throw new Error('Unknown CodeGraph tool.');
  const args = record(value);
  if (Object.keys(args).some(k => !Object.hasOwn(spec.inputSchema.properties, k))) throw new Error('Invalid CodeGraph arguments.');
  for (const key of spec.inputSchema.required) if (!(key in args)) throw new Error(`Missing CodeGraph ${key}.`);
  for (const [key, val] of Object.entries(args)) {
    const schema = spec.inputSchema.properties[key] as { type: string; enum?: string[] };
    if (schema.type === 'string' && typeof val !== 'string') throw new Error('Invalid CodeGraph text.');
    if (schema.type === 'boolean' && typeof val !== 'boolean') throw new Error('Invalid CodeGraph flag.');
    if (schema.type === 'number' && (typeof val !== 'number' || !Number.isFinite(val))) throw new Error(`Invalid CodeGraph ${key}: expected a finite number.`);
    if (schema.enum && !schema.enum.includes(val as string)) throw new Error(`Invalid CodeGraph ${key}.`);
  }
  if (tool === 'codegraph_node' && !args.symbol && !args.file) throw new Error('Provide a symbol or file.');
  if (typeof args.file === 'string') {
    const file = args.file.replace(/^\/workspace\//, '');
    if (/[\0\r\n]/.test(file) || file.startsWith('/') || file.includes('\\') || file.split('/').includes('..') || /^[a-z]:/i.test(file)) throw new Error('CodeGraph files must stay in the assigned project.');
    return { ...args, file };
  }
  return { ...args };
}
export const codegraphInstructions = `\nUse codegraph_explore before planning code changes; use codegraph_search, codegraph_node, codegraph_callers, codegraph_callees, and codegraph_impact for focused follow-ups. These read-only tools query Cheshi's index for this assigned project and do not require command or file-write permission. Cheshi automatically synchronizes the existing host index before tasks and queries and waits for completion; these tools never create an index or grant the worker index-write permission. Treat stale source notices as a reason to read current files. If unavailable, report the limitation and use scoped source reads within your permissions. On isolated verification or delegated work, indexed project source is context only: inspect and verify the actual task snapshot, never substitute the host source for it.\n`;

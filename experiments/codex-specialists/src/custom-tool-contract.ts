export interface CustomTool {
  name: string; description: string; enabled: boolean;
  parameters: { name: string; type: 'string' | 'number' | 'boolean'; description: string; required: boolean }[];
  runtime: 'bun' | 'node' | 'python3'; script: string;
  runtimeVersion?: string;
  execution?: 'host';
  service?: { name: string; script: string; when?: { parameter: string; jsonField: string; values: string[] } };
  network?: { url: string; credential: string | null };
}
export const CUSTOM_TOOL_TIMEOUT_MS = 60_000;
export const MANAGED_HOST_TOOL_TIMEOUT_MS = 90_000;
export function customToolTimeoutMs(tool: CustomTool, args: Record<string, unknown>) {
  return hostServiceRequired(tool, args) ? MANAGED_HOST_TOOL_TIMEOUT_MS : CUSTOM_TOOL_TIMEOUT_MS;
}
export function parseCustomTools(value: unknown): CustomTool[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error('Expected custom tools.');
  const names = new Set<string>();
  return value.map(raw => {
    const t = object(raw);
    if (Object.keys(t).some(k => !['name','description','enabled','parameters','runtime','runtimeVersion','script','network','execution','service'].includes(k))) throw new Error('Unknown custom tool field.');
    if (t.execution !== undefined && t.execution !== 'host') throw new Error('Invalid execution target.');
    if (t.execution === 'host' && t.network !== undefined) throw new Error('Host tools do not use the container HTTPS broker.');
    if (t.runtimeVersion !== undefined && (t.execution !== 'host' || t.runtime !== 'python3'
      || typeof t.runtimeVersion !== 'string' || !/^3\.\d{1,2}\.\d{1,2}$/.test(t.runtimeVersion))) throw new Error('runtimeVersion requires an exact managed host Python version.');
    const name = text(t.name);
    if (!/^[a-z][a-z0-9_]{0,47}$/.test(name) || names.has(name)) throw new Error('Use a unique lowercase tool name.');
    names.add(name);
    if (typeof t.enabled !== 'boolean' || !['bun','node','python3'].includes(String(t.runtime)) || !Array.isArray(t.parameters)) throw new Error('Invalid tool settings.');
    const fields = new Set<string>();
    const parameters = t.parameters.map(raw => {
      const p = object(raw), name = text(p.name);
      if (Object.keys(p).some(k => !['name','description','type','required'].includes(k))) throw new Error('Unknown input field.');
      if (!/^[a-zA-Z][a-zA-Z0-9_]*$/.test(name) || fields.has(name) || !['string','number','boolean'].includes(String(p.type)) || typeof p.required !== 'boolean') throw new Error('Invalid tool input.');
      fields.add(name);
      return { name, type: p.type as 'string' | 'number' | 'boolean', description: text(p.description), required: p.required };
    });
    const script = text(t.script);
    assertScript(script);
    let service: CustomTool['service'];
    if (t.service !== undefined) {
      const s = object(t.service);
      if (t.execution !== 'host' || Object.keys(s).some(k => !['name', 'script', 'when'].includes(k))) throw new Error('Services require a host tool.');
      const serviceName = text(s.name), serviceScript = text(s.script);
      if (!/^[a-z][a-z0-9_]{0,47}$/.test(serviceName)) throw new Error('Invalid host service name.');
      assertScript(serviceScript);
      service = { name: serviceName, script: serviceScript };
      if (s.when !== undefined) {
        const when = object(s.when), parameter = text(when.parameter), jsonField = text(when.jsonField);
        if (Object.keys(when).some(k => !['parameter', 'jsonField', 'values'].includes(k))
          || !parameters.some(p => p.name === parameter && p.type === 'string')
          || !/^[a-zA-Z][a-zA-Z0-9_]*$/.test(jsonField) || !Array.isArray(when.values) || !when.values.length || when.values.length > 50) throw new Error('Invalid host service condition.');
        service.when = { parameter, jsonField, values: when.values.map(text) };
      }
    }
    let network: CustomTool['network'];
    if (t.network !== undefined) {
      const n = object(t.network), url = publicToolUrl(n.url);
      if (Object.keys(n).some(k => !['url','credential'].includes(k))) throw new Error('Unknown endpoint field.');
      const credential = n.credential === null ? null : text(n.credential);
      if (credential !== null && !/^[a-z][a-z0-9_-]{0,63}$/.test(credential)) throw new Error('Invalid credential name.');
      network = { url: url.href, credential };
    }
    return { name, description: text(t.description), enabled: t.enabled, parameters, script, runtime: t.runtime as CustomTool['runtime'],
      ...(t.runtimeVersion !== undefined ? { runtimeVersion: t.runtimeVersion as string } : {}),
      ...(network ? { network } : {}), ...(service ? { service } : {}), ...(t.execution === 'host' ? { execution: 'host' as const } : {}) };
  });
}
function assertScript(script: string) {
  if (!/^scripts\/[a-zA-Z0-9_-][a-zA-Z0-9_./-]*$/.test(script) || script.split('/').some(p => !p || p.startsWith('.'))) throw new Error('Choose a script inside this pack.');
}
export function hostServiceRequired(tool: CustomTool, args: Record<string, unknown>) {
  if (!tool.service) return false;
  const when = tool.service.when;
  if (!when) return true;
  try {
    const input = args[when.parameter];
    if (typeof input !== 'string') return false;
    const value = JSON.parse(input) as Record<string, unknown> | null;
    return value !== null && typeof value[when.jsonField] === 'string' && when.values.includes(value[when.jsonField] as string);
  } catch { return false; }
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Expected a tool object.');
  return value as Record<string, unknown>;
}
function text(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 20_000 || value.includes('\0')) throw new Error('Invalid tool text.');
  return value;
}
export function publicToolUrl(value: unknown): URL {
  const url = new URL(text(value));
  if (url.protocol !== 'https:' || url.username || url.password || url.hash || url.search || url.port || !url.hostname.includes('.') || url.hostname.endsWith('.') || !/^[a-z0-9.-]+$/.test(url.hostname) || /^[\d.]+$/.test(url.hostname) || /\.(local|localhost|internal)$/.test(url.hostname)) throw new Error('Use a public HTTPS endpoint without credentials or a custom port.');
  return url;
}
export function customToolArguments(tool: CustomTool, value: unknown) {
  const args = object(value);
  if (Object.keys(args).some(key => !tool.parameters.some(p => p.name === key))) throw new Error('Unknown tool input.');
  for (const p of tool.parameters) {
    if (!(p.name in args) && !p.required) continue;
    if (typeof args[p.name] !== p.type || (p.type === 'number' && !Number.isFinite(args[p.name]))) throw new Error(`Invalid input: ${p.name}`);
  }
  if (JSON.stringify(args).length > 64 * 1024) throw new Error('Tool input exceeds 64 KiB.');
  return args;
}
export function customToolDefinition(tool: CustomTool) {
  return { type: 'function', name: `homie_${tool.name}`, description: tool.description, inputSchema: { type: 'object', additionalProperties: false,
    properties: Object.fromEntries(tool.parameters.map(p => [p.name, { type: p.type, description: p.description }])), required: tool.parameters.filter(p => p.required).map(p => p.name) } };
}

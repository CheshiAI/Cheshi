import { ToggleSwitch } from '../../shared/ui/ToggleSwitch';
import { useEffect, useRef, useState } from 'react';
import { LiquidGlassSelect, NeumorphicButton, NeumorphicTextField } from '../../shared/ui';
import type { AgentPackage } from '../../../../shared/agent-package';
import type { AgentRegistryModel } from './agentRegistryModel';
import { importHomieTool, type HomieCustomTool } from './customToolImport';
import styles from './SpecialistAgentForm.module.css';
import layout from './HomieSettings.module.css';

export function HomieCustomTools({ pack, savedPack, patch, disabled, model, agentId, engineId, onBusy }: {
  pack: AgentPackage; savedPack?: AgentPackage; patch(value: Partial<AgentPackage>): void; disabled: boolean;
  model: AgentRegistryModel; agentId?: string; engineId?: string | null; onBusy(value: boolean): void;
}) {
  const tools = pack.tools ?? [];
  const [selected, setSelected] = useState(0), [key, setKey] = useState('');
  const [hasKey, setHasKey] = useState<boolean | null>(null), [status, setStatus] = useState<string | null>(null);
  const [inputs, setInputs] = useState<Record<string, string>>({});
  const active = useRef(true), operation = useRef(false);
  const filePicker = useRef<HTMLInputElement>(null), folderPicker = useRef<HTMLInputElement>(null);
  useEffect(() => { active.current = true; return () => { active.current = false; }; }, []);
  const tool = tools[selected];
  let origin = ''; try { if (tool?.network) origin = new URL(tool.network.url).origin; } catch { /* A draft URL may be incomplete. */ }
  const credential = tool?.network?.credential;
  useEffect(() => {
    let canceled = false; setKey(''); setHasKey(null); setStatus(null);
    if (origin && credential) void model.toolCredential({ action: 'status', origin, name: credential }).then(value => {
      if (!canceled) setHasKey(value);
    }, () => { if (!canceled) setHasKey(null); });
    return () => { canceled = true; };
  }, [origin, credential, model]);
  const update = (value: Partial<HomieCustomTool>) => patch({ tools: tools.map((t, index) => index === selected ? { ...t, ...value } : t) });
  const run = async (action: () => Promise<void>) => {
    if (operation.current || disabled) return;
    operation.current = true; onBusy(true); setStatus(null);
    try { await action(); } catch (error) { if (active.current) setStatus(error instanceof Error ? error.message : 'Tool operation failed.'); }
    finally { operation.current = false; if (active.current) onBusy(false); }
  };
  const importFiles = (files: File[]) => {
    if (!files.length) return;
    void run(async () => {
      const imported = await importHomieTool(files, pack);
      if (active.current) { patch(imported); setSelected(tools.length); setInputs({}); setStatus('Tool imported. Review its endpoint, script and dependencies before saving.'); }
    });
  };
  const file = pack.resources?.files.find(f => f.path === tool?.script);
  const savedTool = savedPack?.tools?.find(t => t.name === tool?.name);
  const canTest = Boolean(agentId && engineId && tool?.enabled && savedTool && JSON.stringify(savedTool) === JSON.stringify(tool)
    && JSON.stringify(savedPack?.resources) === JSON.stringify(pack.resources));
  return <div className={layout.section}>
    <h3>Custom tools</h3>
    <p className={styles.description}>Import a tool made outside Cheshi, then save and start the Homie. New tools become available in a new conversation.</p>
    <input hidden type="file" accept=".json" aria-label="Import tool file" ref={filePicker} disabled={disabled}
      onChange={event => { const files = Array.from(event.currentTarget.files ?? []); event.currentTarget.value = ''; importFiles(files); }} />
    <input hidden type="file" multiple aria-label="Import tool folder" disabled={disabled} ref={element => {
      folderPicker.current = element; element?.setAttribute('webkitdirectory', '');
    }} onChange={event => { const files = Array.from(event.currentTarget.files ?? []); event.currentTarget.value = ''; importFiles(files); }} />
    <div className={layout.actions}>
      <NeumorphicButton variant="ghost" disabled={disabled} onClick={() => filePicker.current?.click()}>Import tool file…</NeumorphicButton>
      <NeumorphicButton variant="ghost" disabled={disabled} onClick={() => folderPicker.current?.click()}>Import tool folder…</NeumorphicButton>
    </div>
    {tools.length > 0 && <LiquidGlassSelect ariaLabel="Custom tool" menuAppearance="toolbar" triggerAppearance="standard" value={String(selected)} disabled={disabled}
      options={tools.map((t, index) => ({ value: String(index), label: t.name || 'Unnamed tool' }))}
      onChange={value => { setSelected(Number(value)); setInputs({}); setStatus(null); }} />}
    {tool && <>
      <div className={styles.switchRow}><span>Enable tool</span><ToggleSwitch aria-label="Enable custom tool" checked={tool.enabled} disabled={disabled} onChange={enabled => update({ enabled })} /></div>
      <label className={styles.field}>Tool name<NeumorphicTextField variant="standard" aria-label="Custom tool name" value={tool.name} onChange={event => update({ name: event.target.value })} /></label>
      <label className={styles.field}>Description<NeumorphicTextField variant="standard" multiline rows={2} aria-label="Custom tool description" value={tool.description} onChange={event => update({ description: event.target.value })} /></label>
      <h4>Inputs</h4>
      {tool.parameters.map((parameter, index) => {
        const change = (value: Partial<typeof parameter>) => update({ parameters: tool.parameters.map((p, i) => i === index ? { ...p, ...value } : p) });
        return <div className={layout.section} key={index}>
          <label className={styles.field}>Input name<NeumorphicTextField variant="standard" aria-label={`Input ${index + 1} name`} value={parameter.name} onChange={event => change({ name: event.target.value })} /></label>
          <LiquidGlassSelect ariaLabel={`Input ${index + 1} type`} menuAppearance="toolbar" triggerAppearance="standard" value={parameter.type}
            options={['string','number','boolean'].map(value => ({ value, label: value }))} onChange={value => change({ type: value as typeof parameter.type })} />
          <label className={styles.field}>Description<NeumorphicTextField variant="standard" aria-label={`Input ${index + 1} description`} value={parameter.description} onChange={event => change({ description: event.target.value })} /></label>
          <div className={styles.switchRow}><span>Required</span><ToggleSwitch aria-label={`Input ${index + 1} required`} checked={parameter.required} onChange={required => change({ required })} /></div>
          <NeumorphicButton variant="ghost" onClick={() => update({ parameters: tool.parameters.filter((_, i) => i !== index) })}>Remove input</NeumorphicButton>
        </div>;
      })}
      <NeumorphicButton variant="ghost" onClick={() => update({ parameters: [...tool.parameters, { name: `input_${tool.parameters.length + 1}`, type: 'string', description: 'Describe this input.', required: true }] })}>Add input</NeumorphicButton>
      <h4>Execution</h4>
      <LiquidGlassSelect ariaLabel="Tool runtime" menuAppearance="toolbar" triggerAppearance="standard" value={tool.runtime}
        options={['bun','node','python3'].map(value => ({ value, label: value }))} onChange={value => {
          const runtime = value as HomieCustomTool['runtime'];
          patch({ tools: tools.map((t, i) => i === selected ? { ...t, runtime } : t),
            ...(runtime === 'python3' && !pack.resources?.programs.some(p => p.split('=')[0] === 'python3') ? { resources: { files: pack.resources?.files ?? [], programs: [...pack.resources?.programs ?? [], 'python3'] } } : {}) });
        }} />
      <LiquidGlassSelect ariaLabel="Tool script" menuAppearance="toolbar" triggerAppearance="standard" value={tool.script}
        options={(pack.resources?.files ?? []).filter(f => f.path.startsWith('scripts/')).map(f => ({ value: f.path, label: f.path }))} onChange={script => update({ script })} />
      {file && <label className={styles.field}>Script<NeumorphicTextField variant="standard" multiline rows={10} aria-label="Tool script content" value={file.content}
        onChange={event => patch({ resources: { programs: pack.resources?.programs ?? [], files: (pack.resources?.files ?? []).map(f => f.path === tool.script ? { ...f, content: event.target.value } : f) } })} /></label>}
      <p className={styles.description}>The script reads JSON from stdin and writes {'{ "result": … }'} or {'{ "request": { "body": … } }'} to stdout. It runs in an isolated container without project files or network access. A request is posted to the endpoint below. Add dependencies in Files and environment.</p>
      <div className={styles.switchRow}><span>External API</span><ToggleSwitch aria-label="Tool external API" checked={Boolean(tool.network)} onChange={enabled => update({ network: enabled ? { url: '', credential: null } : undefined })} /></div>
      {tool.network && <>
        <label className={styles.field}>HTTPS endpoint<NeumorphicTextField variant="standard" aria-label="Tool endpoint" value={tool.network.url} onChange={event => update({ network: { ...tool.network!, url: event.target.value } })} /></label>
        <label className={styles.field}>Credential name (optional)<NeumorphicTextField variant="standard" aria-label="Tool credential name" value={credential ?? ''} onChange={event => update({ network: { ...tool.network!, credential: event.target.value || null } })} /></label>
        {credential && <>
          <p className={styles.description}>Bearer API key for {origin || 'this endpoint'}. Stored on this computer and excluded from exports.</p>
          <p role="status">{hasKey === true ? 'API key available.' : hasKey === false ? 'API key required.' : 'Enter a valid endpoint to check credentials.'}</p>
          <label className={styles.field}>API key<NeumorphicTextField variant="standard" type="password" autoComplete="off" aria-label="Tool API key" value={key} onChange={event => setKey(event.target.value)} /></label>
          <div className={layout.actions}>
            <NeumorphicButton variant="ghost" disabled={!key.trim() || !origin || disabled} onClick={() => { void run(async () => { const value = await model.toolCredential({ action: 'save', origin, name: credential, value: key }); if (active.current) { setHasKey(value); setKey(''); } }); }}>Save API key</NeumorphicButton>
            <NeumorphicButton variant="ghost" disabled={!origin || disabled} onClick={() => { void run(async () => { const value = await model.toolCredential({ action: 'remove', origin, name: credential }); if (active.current) { setHasKey(value); setKey(''); setStatus('API key removed.'); } }); }}>Remove API key</NeumorphicButton>
          </div>
        </>}
      </>}
      <h4>Test tool</h4>
      {!canTest && <p className={styles.description}>Save this Homie, select its Docker engine, and start it to test the saved tool.</p>}
      {tool.parameters.map(p => <label className={styles.field} key={p.name}>{p.name}<NeumorphicTextField variant="standard" aria-label={`Test input ${p.name}`} value={inputs[p.name] ?? ''}
        placeholder={p.type === 'boolean' ? 'true or false' : p.description} onChange={event => setInputs({ ...inputs, [p.name]: event.target.value })} /></label>)}
      <NeumorphicButton variant="ghost" disabled={!canTest || disabled} onClick={() => { void run(async () => {
        const args = Object.fromEntries(tool.parameters.flatMap(p => {
          const value = inputs[p.name] ?? '';
          if (!value && !p.required) return [];
          if (p.type === 'boolean' && !['true','false'].includes(value)) throw new Error(`${p.name}: enter true or false.`);
          if (p.type === 'number' && (!value.trim() || !Number.isFinite(Number(value)))) throw new Error(`${p.name}: enter a number.`);
          return [[p.name, p.type === 'number' ? Number(value) : p.type === 'boolean' ? value === 'true' : value]];
        }));
        const result = await model.testTool({ agentId: agentId!, engineId: engineId!, tool: tool.name, args });
        if (active.current) setStatus(JSON.stringify(result, null, 2));
      }); }}>Run test{tool.network ? ' · sends inputs to API' : ''}</NeumorphicButton>
      <NeumorphicButton variant="ghost" onClick={() => { patch({ tools: tools.filter((_, i) => i !== selected) }); setSelected(0); setStatus(null); }}>Remove tool</NeumorphicButton>
    </>}
    {status && <pre className={layout.toolResult} role="status">{status}</pre>}
  </div>;
}

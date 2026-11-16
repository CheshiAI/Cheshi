import { useState } from 'react';
import { Trash2 } from 'lucide-react';
import { AGENT_PACKAGE_TOOLS, type AgentPackage } from '../../../../shared/agent-package';
import { parseHomiePackResources } from '../../../../shared/homie-pack';
import { NeumorphicButton, NeumorphicTextField } from '../../shared/ui';
import { TooltipButton } from '../../shared/ui/TooltipButton';
import { ToggleSwitch } from '../../shared/ui/ToggleSwitch';
import form from './SpecialistAgentForm.module.css';
import styles from './HomieSettings.module.css';

const toolLabels = { codegraph: 'CodeGraph · Code exploration', collaboration: 'Collaboration · Work with other Homies', verification: 'Verification · Independent review' };
type Props = { pack: AgentPackage; disabled: boolean; patch(values: Partial<AgentPackage>): void };
export function HomieTools({ pack, disabled, patch }: Props) {
  return <>
    {AGENT_PACKAGE_TOOLS.map(tool => <div key={tool} className={form.switchRow}><span>{toolLabels[tool]}</span>
      <ToggleSwitch aria-label={`Enable ${tool}`} checked={(pack.enabledTools ?? AGENT_PACKAGE_TOOLS).includes(tool)} disabled={disabled} onChange={enabled => patch({
        enabledTools: enabled ? [...new Set([...(pack.enabledTools ?? AGENT_PACKAGE_TOOLS), tool])] : (pack.enabledTools ?? AGENT_PACKAGE_TOOLS).filter(item => item !== tool),
        requiredTools: enabled ? [...new Set([...pack.requiredTools, tool])] : pack.requiredTools.filter(item => item !== tool),
      })} /></div>)}
    <p className={form.description}>Save the Homie and start its idle worker. Newly enabled tools need a new conversation. Project permissions still apply.</p>
  </>;
}
export function HomiePrograms({ pack, disabled, patch, report }: Props & { report(message: string): void }) {
  const [program, setProgram] = useState('');
  const files = pack.resources?.files ?? [], programs = pack.resources?.programs ?? [];
  const resource = (values: Partial<NonNullable<AgentPackage['resources']>>) => patch({ resources: { files, programs, ...values } });
  return <>
    <h3>Programs</h3>
    <p className={form.description}>Programs are prepared when the worker starts. An unchanged image is reused.</p>
    <div className={styles.actions}>{['python3', 'jq', 'git'].filter(item => !programs.includes(item)).map(item => <NeumorphicButton key={item} variant="ghost" disabled={disabled} onClick={() => resource({ programs: [...programs, item] })}>Add {item}</NeumorphicButton>)}</div>
    {programs.map(item => <div key={item} className={styles.row}><span>{item}</span><TooltipButton variant="ghost" size="icon" title="Remove program" aria-label={`Remove program ${item}`} disabled={disabled} onClick={() => resource({ programs: programs.filter(value => value !== item) })}><Trash2 aria-hidden="true" /></TooltipButton></div>)}
    <details><summary>Other Linux programs</summary><div className={styles.advanced}>
      <label className={form.field}>Debian package name<NeumorphicTextField variant="standard" aria-label="Linux package name" placeholder="name or name=version" value={program} disabled={disabled} onChange={event => setProgram(event.target.value)} /></label>
      <NeumorphicButton variant="ghost" disabled={disabled || !program.trim()} onClick={() => {
        try { const result = parseHomiePackResources({ files, programs: [...programs, program.trim()] }); resource({ programs: result.programs }); setProgram(''); }
        catch (error) { report(error instanceof Error ? error.message : 'Invalid program.'); }
      }}>Add program</NeumorphicButton>
    </div></details>
  </>;
}

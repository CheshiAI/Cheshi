import { useEffect, useState } from 'react';
import type { AgentModel, AgentModelSelection } from '../../../../shared/agent-models';
import { selectAgentModel } from '../../../../shared/agent-models';
import { LiquidGlassSelect, NeumorphicButton } from '../../shared/ui';
import type { LiquidGlassSelectOption } from '../../shared/ui/LiquidGlassSelect';
import { fastTierForModel, formatReasoningEffort } from '../chat/chatViewModel';
import styles from './SpecialistAgentForm.module.css';

interface Catalog { accountId: string | null; models: AgentModel[]; loading: boolean; error: string | null; }
export function useSpecialistModels(accountId: string | null, load: (id: string) => Promise<AgentModel[]>) {
  const [attempt, setAttempt] = useState(0);
  const [catalog, setCatalog] = useState<Catalog>({ accountId: null, models: [], loading: false, error: null });
  useEffect(() => {
    let active = true;
    setCatalog({ accountId, models: [], loading: accountId !== null, error: null });
    if (accountId) void load(accountId).then(models => {
      if (active) setCatalog({ accountId, models, loading: false, error: null });
    }, error => {
      if (active) setCatalog({ accountId, models: [], loading: false,
        error: error instanceof Error ? error.message : 'Could not load models.' });
    });
    return () => { active = false; };
  }, [accountId, load, attempt]);
  const current = catalog.accountId === accountId ? catalog : { accountId, models: [], loading: accountId !== null, error: null };
  return { ...current, retry: () => setAttempt(value => value + 1) };
}

export function SpecialistModelSettings({ selection, catalog, disabled, onChange }: {
  selection: AgentModelSelection; catalog: ReturnType<typeof useSpecialistModels>; disabled: boolean;
  onChange(value: AgentModelSelection): void;
}) {
  const model = catalog.models.find(item => item.model === selection.model);
  const fastTier = fastTierForModel(model);
  const unavailable = disabled || !catalog.accountId || catalog.loading || Boolean(catalog.error);
  const models: LiquidGlassSelectOption<string>[] = [{ value: '', label: 'Runtime default' }, ...catalog.models.map(item => ({
    value: item.model, label: item.displayName, description: item.description,
  }))];
  if (selection.model && !model) models.push({ value: selection.model, label: `${selection.model} (unavailable)`, disabled: true });
  const efforts: LiquidGlassSelectOption<string>[] = [{ value: '', label: model ? `Model default (${formatReasoningEffort(model.defaultReasoningEffort)})` : 'Model default' },
    ...(model?.supportedReasoningEfforts.map(option => ({ value: option.effort,
      label: formatReasoningEffort(option.effort), description: option.description })) ?? [])];
  if (selection.reasoningEffort && !efforts.some(item => item.value === selection.reasoningEffort)) {
    efforts.push({ value: selection.reasoningEffort, label: `${formatReasoningEffort(selection.reasoningEffort)} (unavailable)`, disabled: true });
  }
  const tiers: LiquidGlassSelectOption<string>[] = [{ value: '', label: 'Standard' }, ...(fastTier ? [{ value: fastTier.id, label: fastTier.name }] : [])];
  if (selection.serviceTier && !tiers.some(item => item.value === selection.serviceTier)) {
    tiers.push({ value: selection.serviceTier, label: `${selection.serviceTier} (unavailable)`, disabled: true });
  }
  return <>
    <div className={styles.field}><span>Model</span><LiquidGlassSelect ariaLabel="Agent model" menuAppearance="toolbar" triggerAppearance="standard"
      value={selection.model ?? ''} options={models} disabled={unavailable}
      onChange={id => onChange(selectAgentModel(selection, catalog.models.find(item => item.model === id)))} /></div>
    <div className={styles.field}><span>Reasoning</span><LiquidGlassSelect ariaLabel="Agent reasoning effort" menuAppearance="toolbar" triggerAppearance="standard"
      value={selection.reasoningEffort ?? ''} options={efforts} disabled={unavailable || !model}
      onChange={reasoningEffort => onChange({ ...selection, reasoningEffort: reasoningEffort || null })} /></div>
    <div className={styles.field}><span>Service tier</span><LiquidGlassSelect ariaLabel="Agent service tier" menuAppearance="toolbar" triggerAppearance="standard"
      value={selection.serviceTier ?? ''} options={tiers} disabled={unavailable || !model}
      onChange={serviceTier => onChange({ ...selection, serviceTier: serviceTier || null })} /></div>
    {!catalog.accountId && <p className={styles.description}>Select an account to choose a model and reasoning effort.</p>}
    {catalog.loading && <p className={styles.description} role="status">Loading models…</p>}
    {catalog.error && <div className={styles.field}><p className={styles.description} role="alert">{catalog.error}</p>
      <NeumorphicButton variant="ghost" disabled={disabled} onClick={catalog.retry}>Retry model list</NeumorphicButton></div>}
  </>;
}

import { useEffect, useSyncExternalStore } from 'react';
import type { HomieCatalog, HomieAccountsApi } from './homieCatalog';
import type { AgentModelSelection } from '../../../../shared/agent-models';
import { selectAgentModel } from '../../../../shared/agent-models';
import { LiquidGlassSelect, NeumorphicButton } from '../../shared/ui';
import type { LiquidGlassSelectOption } from '../../shared/ui/LiquidGlassSelect';
import { fastTierForModel, formatReasoningEffort } from '../chat/chatViewModel';
import styles from './SpecialistAgentForm.module.css';

export function useHomieAccounts(store: HomieCatalog, api?: HomieAccountsApi) {
  const snapshot = useSyncExternalStore(store.subscribe, store.accountsSnapshot);
  useEffect(() => {
    if (api) { store.connectAccounts(api); void store.ensureAccounts(); }
  }, [store, api]);
  return snapshot;
}

export function useSpecialistModels(accountId: string | null, store: HomieCatalog) {
  const catalog = useSyncExternalStore(store.subscribe, () => store.modelSnapshot(accountId));
  // Reload an invalidated entry, but keep successful lists visible during background refresh.
  const missing = catalog.models.length === 0 && !catalog.loading && !catalog.error;
  useEffect(() => {
    if (accountId) void store.loadModels(accountId).catch(() => {});
  }, [accountId, store, missing]);
  return { ...catalog, retry: () => { if (accountId) void store.loadModels(accountId, true).catch(() => {}); } };
}

export function SpecialistModelSettings({ selection, catalog, disabled, onChange }: {
  selection: AgentModelSelection; catalog: ReturnType<typeof useSpecialistModels>; disabled: boolean;
  onChange(value: AgentModelSelection): void;
}) {
  const model = catalog.models.find(item => item.model === selection.model);
  const fastTier = fastTierForModel(model);
  const unavailable = disabled || !catalog.accountId || catalog.loading || (!catalog.models.length && Boolean(catalog.error));
  const models: LiquidGlassSelectOption<string>[] = catalog.models.map(item => ({
    value: item.model, label: item.displayName, description: item.description,
  }));
  if (selection.model && !model) models.push({ value: selection.model, label: `${selection.model} (unavailable)`, disabled: true });
  const efforts: LiquidGlassSelectOption<string>[] = model?.supportedReasoningEfforts.map(option => ({ value: option.effort,
    label: formatReasoningEffort(option.effort), description: option.description })) ?? [];
  if (selection.reasoningEffort && !efforts.some(item => item.value === selection.reasoningEffort)) {
    efforts.push({ value: selection.reasoningEffort, label: `${formatReasoningEffort(selection.reasoningEffort)} (unavailable)`, disabled: true });
  }
  const tiers: LiquidGlassSelectOption<string>[] = [{ value: '', label: 'Standard' }, ...(fastTier ? [{ value: fastTier.id, label: fastTier.name }] : [])];
  if (selection.serviceTier && !tiers.some(item => item.value === selection.serviceTier)) {
    tiers.push({ value: selection.serviceTier, label: `${selection.serviceTier} (unavailable)`, disabled: true });
  }
  return <>
    <div className={`${styles.field} ${styles.accountRow}`}><span>Model</span><LiquidGlassSelect ariaLabel="Agent model" menuAppearance="toolbar" triggerAppearance="standard"
      placeholder={catalog.loading ? 'Loading models…' : 'Choose a model'} value={selection.model ?? ''} options={models} disabled={unavailable}
      onChange={id => onChange(selectAgentModel(selection, catalog.models.find(item => item.model === id)))} /></div>
    <div className={`${styles.field} ${styles.accountRow}`}><span>Effort</span><LiquidGlassSelect ariaLabel="Agent reasoning effort" menuAppearance="toolbar" triggerAppearance="standard"
      placeholder="Choose effort" value={selection.reasoningEffort ?? ''} options={efforts} disabled={unavailable || !model}
      onChange={reasoningEffort => onChange({ ...selection, reasoningEffort: reasoningEffort || null })} /></div>
    <div className={`${styles.field} ${styles.accountRow}`}><span>Speed</span><LiquidGlassSelect ariaLabel="Agent service tier" menuAppearance="toolbar" triggerAppearance="standard"
      value={selection.serviceTier ?? ''} options={tiers} disabled={unavailable || !model}
      onChange={serviceTier => onChange({ ...selection, serviceTier: serviceTier || null })} /></div>
    {!catalog.accountId && <p className={styles.description}>Select an account to choose a model and reasoning effort.</p>}
    {catalog.loading && <p className={styles.description} role="status">Loading models…</p>}
    {catalog.error && <div className={styles.field}><p className={styles.description} role="alert">{catalog.error}</p>
      <NeumorphicButton variant="ghost" disabled={disabled} onClick={catalog.retry}>Retry model list</NeumorphicButton></div>}
  </>;
}

export interface AgentModel {
  id: string; model: string; displayName: string; description: string; isDefault: boolean;
  defaultReasoningEffort: string;
  supportedReasoningEfforts: { effort: string; description: string }[];
  serviceTiers: { id: string; name: string; description: string }[];
  defaultServiceTier: string | null;
}
export interface AgentModelSelection {
  model: string | null; reasoningEffort: string | null; serviceTier: string | null;
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('Invalid agent model catalog.');
  return value as Record<string, unknown>;
}
function text(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 20_000 || value.includes('\0')) {
    throw new TypeError('Invalid agent model catalog text.');
  }
  return value;
}
function list(value: unknown): unknown[] {
  if (!Array.isArray(value) || value.length > 1000) throw new TypeError('Invalid agent model catalog list.');
  return value;
}
export function parseAgentModels(value: unknown): AgentModel[] {
  return list(value).map(raw => {
    const item = record(raw);
    if (item.isDefault !== true && item.isDefault !== false) throw new TypeError('Invalid default model flag.');
    const model: AgentModel = {
      id: text(item.id), model: text(item.model), displayName: text(item.displayName),
      description: typeof item.description === 'string' ? item.description : '', isDefault: item.isDefault,
      defaultReasoningEffort: text(item.defaultReasoningEffort),
      supportedReasoningEfforts: list(item.supportedReasoningEfforts).map(rawEffort => {
        const effort = record(rawEffort);
        return { effort: text(effort.effort), description: text(effort.description) };
      }),
      serviceTiers: list(item.serviceTiers).map(rawTier => {
        const tier = record(rawTier);
        return { id: text(tier.id), name: text(tier.name), description: text(tier.description) };
      }),
      defaultServiceTier: item.defaultServiceTier === null ? null : text(item.defaultServiceTier),
    };
    if (!model.supportedReasoningEfforts.some(option => option.effort === model.defaultReasoningEffort)) {
      throw new TypeError('Default reasoning effort is missing from the model catalog.');
    }
    return model;
  });
}

export function selectAgentModel(selection: AgentModelSelection, model: AgentModel | undefined): AgentModelSelection {
  if (!model) return { model: null, reasoningEffort: null, serviceTier: null };
  return { model: model.model,
    reasoningEffort: model.supportedReasoningEfforts.some(option => option.effort === selection.reasoningEffort)
      ? selection.reasoningEffort : model.defaultReasoningEffort,
    serviceTier: model.serviceTiers.some(tier => tier.id === selection.serviceTier) ? selection.serviceTier : null };
}

export function assertAgentModelSelection(selection: AgentModelSelection, models: readonly AgentModel[]): void {
  if (selection.model === null) {
    if (selection.reasoningEffort !== null || selection.serviceTier !== null) throw new Error('Select a model before configuring reasoning or service tier.');
    return;
  }
  const model = models.find(item => item.model === selection.model);
  if (!model) throw new Error('The selected model is unavailable for this account.');
  if (selection.reasoningEffort !== null && !model.supportedReasoningEfforts.some(option => option.effort === selection.reasoningEffort)) {
    throw new Error('The selected reasoning effort is not supported by this model.');
  }
  if (selection.serviceTier !== null && !model.serviceTiers.some(tier => tier.id === selection.serviceTier)) {
    throw new Error('The selected service tier is not supported by this model.');
  }
}

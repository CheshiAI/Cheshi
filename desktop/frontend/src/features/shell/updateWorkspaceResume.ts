export interface UpdateResumeSnapshot {
  schemaVersion: 1;
  workspaceRoot: string;
  createdAt: number;
  sections: Record<string, unknown>;
}

export interface UpdateResumeParticipant {
  capture(): unknown;
  restore(value: unknown): void | Promise<void>;
  committed?(value: unknown): void;
  cancelled?(): void;
}

export function resumeRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : null;
}

export function parseUpdateResume(value: unknown, workspaceRoot: string): UpdateResumeSnapshot {
  const record = resumeRecord(value);
  if (!record || record.schemaVersion !== 1 || record.workspaceRoot !== workspaceRoot
    || typeof record.createdAt !== 'number' || !Number.isFinite(record.createdAt)
    || record.createdAt > Date.now() + 60_000 || !resumeRecord(record.sections)) {
    throw new Error('The saved update workspace is invalid or belongs to another workspace.');
  }
  return record as unknown as UpdateResumeSnapshot;
}

export function createUpdateResumeCoordinator() {
  const participants = new Map<string, UpdateResumeParticipant>();
  let cancellation = 0;
  let prepared: Array<{ participant: UpdateResumeParticipant; value: unknown }> | null = null;
  return {
    register(name: string, participant: UpdateResumeParticipant): () => void {
      participants.set(name, participant);
      return () => { if (participants.get(name) === participant) participants.delete(name); };
    },
    async restore(value: unknown, workspaceRoot: string): Promise<void> {
      if (value === null) return;
      const snapshot = parseUpdateResume(value, workspaceRoot);
      // Require every saved section to have its owner mounted; never silently discard drafts.
      for (const name of Object.keys(snapshot.sections)) {
        if (!participants.has(name)) throw new Error(`Cannot restore the saved ${name} workspace yet.`);
      }
      for (const [name, participant] of participants) {
        if (Object.hasOwn(snapshot.sections, name)) await participant.restore(snapshot.sections[name]);
      }
    },
    async prepare(workspaceRoot: string, save: (snapshot: UpdateResumeSnapshot) => Promise<void>): Promise<void> {
      const currentCancellation = cancellation;
      const entries = [...participants];
      const sections = Object.fromEntries(entries.map(([name, participant]) => [name, participant.capture()]));
      await save({ schemaVersion: 1, workspaceRoot, createdAt: Date.now(), sections });
      if (currentCancellation !== cancellation) throw new Error('Update preparation was cancelled.');
      prepared = entries.map(([name, participant]) => ({ participant, value: sections[name] }));
    },
    commit(): void {
      if (!prepared) throw new Error('No saved workspace is ready for update installation.');
      for (const { participant, value } of prepared) participant.committed?.(value);
    },
    cancel(): void { prepared = null; cancellation += 1; for (const participant of participants.values()) participant.cancelled?.(); },
  };
}

export const updateResumeCoordinator = createUpdateResumeCoordinator();

import type { ManagedAgent } from '../../../../shared/agent-management';

export function workerDisplayName(worker: ManagedAgent, profiles: readonly { id: string; name: string }[] = []) {
  return profiles.find(profile => profile.id === worker.profileId)?.name ?? worker.name;
}

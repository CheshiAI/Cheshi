import { skillCatalogRevision } from '../../shared/skillCatalogChanges';
import type { ChatSkill } from './model';

export function createSkillCatalogCache(load: () => Promise<ChatSkill[]>, revision = skillCatalogRevision) {
  let value: ChatSkill[] | undefined;
  let cachedRevision = -1;
  let pending: Promise<ChatSkill[]> | undefined;
  let pendingRevision = -1;
  const peek = () => cachedRevision === revision() ? value : undefined;
  async function read(): Promise<ChatSkill[]> {
    const cached = peek();
    if (cached !== undefined) return cached;
    const requestedRevision = revision();
    if (pending && pendingRevision === requestedRevision) return pending;
    pendingRevision = requestedRevision;
    const request = Promise.resolve().then(load).then((skills) => {
      if (requestedRevision !== revision()) return read();
      value = skills;
      cachedRevision = requestedRevision;
      return skills;
    }).finally(() => { if (pending === request) pending = undefined; });
    pending = request;
    return request;
  }
  return { peek, read };
}

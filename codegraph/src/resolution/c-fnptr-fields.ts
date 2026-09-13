import {
  FNPTR_DECL_RE,
  type RawFieldDecl
} from './c-fnptr-facts';
import {
  splitTopLevel
} from './c-fnptr-preprocessor';



// Parse a struct body (the text between its `{` and `}`) into ordered fields,
// structure only — see RawFieldDecl for why classification is deferred.
export const parseStructFieldsRaw = (inner: string): RawFieldDecl[] => {
  const fields: RawFieldDecl[] = [];
  let idx = 0;
  for (const rawDecl of splitTopLevel(inner, ';')) {
    const decl = rawDecl.trim();
    if (!decl) continue;
    // A field decl can declare several names sharing a leading type:
    // `struct redisCommand *cmd, *lastcmd;`. Each declarator is its own
    // positional slot and carries that type (so `client.cmd → redisCommand`).
    const parts = splitTopLevel(decl, ',');
    const firstTyped = parts[0]!.match(/(\w+)\s+\**\s*(\w+)\s*$/);
    const sharedType = firstTyped ? firstTyped[1]! : '';
    for (let pi = 0; pi < parts.length; pi++) {
      const p = parts[pi]!.trim();
      let name: string | null = null;
      let type = '';
      let ptr = false;
      const pm = p.match(FNPTR_DECL_RE);
      if (pm) {
        name = pm[1]!; // `… (*name)(…)` — a function pointer
        ptr = true;
      } else if (pi === 0) {
        if (firstTyped) { name = firstTyped[2]!; type = sharedType; }
      } else {
        // a subsequent declarator: `*name` / `**name` / `name`
        const dm = p.match(/^\**\s*(\w+)/);
        if (dm) { name = dm[1]!; type = sharedType; }
      }
      // Always advance the positional index. An unparsed field (anonymous
      // union, exotic declarator) still occupies one slot, and macro-expanded
      // positional tables (redis' MAKE_CMD) only align if every field counts.
      fields.push({ name, index: idx, ptr, type });
      idx++;
    }
  }
  return fields;
};

import { cp, lstat, mkdir, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';

/** Only the generated Homie namespace is replaced; account skills and conversation data survive. */
export async function installHomieSkills(codexHome: string, source = '/opt/cheshi/homie-pack/skills'): Promise<void> {
  const directory = join(codexHome, 'skills');
  await mkdir(directory, { recursive: true });
  if ((await lstat(directory)).isSymbolicLink()) throw new Error('The skill directory must not be a symbolic link.');
  let entries: string[];
  try { entries = await readdir(source); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') entries = []; else throw error; }
  for (const name of await readdir(directory)) {
    if (name.startsWith('cheshi-homie-')) await rm(join(directory, name), { recursive: true, force: true });
  }
  for (const name of entries) {
    if (!/^[a-zA-Z0-9_-]+$/.test(name)) throw new Error('Invalid Homie skill directory.');
    const skill = join(source, name);
    if (!(await lstat(skill)).isDirectory() || !(await lstat(join(skill, 'SKILL.md'))).isFile()) throw new Error('A Homie skill requires SKILL.md.');
    await cp(skill, join(directory, `cheshi-homie-${name}`), { recursive: true, dereference: false, errorOnExist: true, force: false });
  }
}

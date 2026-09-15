import { useId } from 'react';
import type { AppleNotesFolder } from '../../../../shared/apple-notes';
import { NeumorphicSurface } from '../../shared/ui';
import styles from './AppleNotes.module.css';

export function AppleNotesFolderField({ folders, value, disabled, onChange }: {
  folders: AppleNotesFolder[]; value: string; disabled: boolean; onChange: (id: string) => void;
}) {
  const id = useId();
  return <label className={styles.field} htmlFor={id}>
    <span>Folder</span>
    <NeumorphicSurface raised highlightFocus className={styles.selectSurface}>
      <select id={id} value={value} disabled={disabled || folders.length === 0} onChange={event => onChange(event.target.value)}>
        {folders.length === 0 && <option value="">No folders available</option>}
        {folders.map(folder => <option key={folder.id} value={folder.id}>{folder.account} / {folder.path}</option>)}
      </select>
    </NeumorphicSurface>
  </label>;
}

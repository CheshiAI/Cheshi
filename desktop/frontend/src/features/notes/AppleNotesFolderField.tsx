import type { AppleNotesFolder } from '../../../../shared/apple-notes';
import { LiquidGlassSelect } from '../../shared/ui';
import styles from './AppleNotes.module.css';

export function AppleNotesFolderField({ folders, value, disabled, onChange }: {
  folders: AppleNotesFolder[]; value: string; disabled: boolean; onChange: (id: string) => void;
}) {
  return <div className={styles.field}>
    <span>Folder</span>
    <LiquidGlassSelect ariaLabel="Folder" triggerAppearance="standard" menuAppearance="toolbar"
      value={value} disabled={disabled || folders.length === 0} onChange={onChange}
      placeholder={folders.length === 0 ? 'No folders available' : 'Choose a folder'}
      options={folders.map(folder => ({
        value: folder.id, label: `${folder.account} / ${folder.path}`, description: `${folder.account} / ${folder.path}`,
      }))} />
  </div>;
}

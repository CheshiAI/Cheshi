import { FileCode2 } from 'lucide-react';
import type { ReactNode } from 'react';
import type { FileEvidenceEntry } from './fileEvidenceModel';
import styles from './FileEvidence.module.css';

export function FileEvidence({ files, renderLink, heading = true }: {
  files: Pick<FileEvidenceEntry, 'file' | 'path'>[];
  renderLink: (path: string, name: string) => ReactNode;
  heading?: boolean;
}) {
  return <section className={styles.section} data-heading={heading ? 'true' : 'false'}>
    {heading && <h3 className={styles.heading}>Files · {files.length}</h3>}
    <ul className={styles.files} aria-label="Evidence files">
      {files.map((file, index) => {
        const path = file.path ?? file.file;
        const name = path.split('/').at(-1)!;
        const directory = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : file.path ? 'root' : null;
        return <li className={styles.file} key={`${file.file}:${index}`}>
          <FileCode2 aria-hidden="true" />
          <div className={styles.label}>
            <span className={styles.name}>{file.path ? renderLink(file.path, name) : name}</span>
            {directory && <span className={styles.path}>{directory}</span>}
          </div>
        </li>;
      })}
    </ul>
  </section>;
}

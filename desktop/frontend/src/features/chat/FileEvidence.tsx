import { FileCode2, Files } from 'lucide-react';
import type { ReactNode } from 'react';
import { ContentCard } from '../../shared/ui/ContentCard';
import type { FileEvidenceEntry } from './fileEvidenceModel';
import styles from './FileEvidence.module.css';

export function FileEvidence({ files, renderLink }: {
  files: FileEvidenceEntry[];
  renderLink: (path: string, name: string) => ReactNode;
}) {
  return <ContentCard title="File evidence" icon={<Files aria-hidden="true" />}
    status={`${files.length} ${files.length === 1 ? 'file' : 'files'}`} className={styles.card}>
    <div className={styles.files} role="list" aria-label="Evidence files">
      {files.map((file, index) => {
        const path = file.path ?? file.file;
        const name = path.split('/').at(-1)!;
        const directory = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : file.path ? 'root' : null;
        return <div className={styles.file} role="listitem" key={`${file.file}:${index}`}>
          <FileCode2 aria-hidden="true" />
          <div className={styles.label}>
            <span className={styles.name}>{file.path ? renderLink(file.path, name) : name}</span>
            {directory && <span className={styles.path}>{directory}</span>}
          </div>
        </div>;
      })}
    </div>
    <details className={styles.details}>
      <summary>SHA-256 details</summary>
      <dl className={styles.hashes}>
        {files.map((file, index) => <div key={`${file.file}:${index}`}>
          <dt>{file.file}</dt><dd>{file.sha256}</dd>
        </div>)}
      </dl>
    </details>
  </ContentCard>;
}

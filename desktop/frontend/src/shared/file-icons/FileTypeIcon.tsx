import { FileText } from 'lucide-react';

import { resolveFileIcon } from './fileIconResolver';
import './file-icon-layout.css';

export function FileTypeIcon({ className, name, path }: {
  className?: string;
  name: string;
  path: string;
}) {
  const resolved = resolveFileIcon(path, name);
  if (!resolved) return <FileText className={className} aria-hidden="true" />;

  const src = new URL(`./assets/${resolved.icon}.svg?no-inline`, import.meta.url).href;
  return (
    <img
      className={[className, 'workspace-file-type-icon'].filter(Boolean).join(' ')}
      src={src}
      alt=""
      aria-hidden="true"
      draggable={false}
    />
  );
}

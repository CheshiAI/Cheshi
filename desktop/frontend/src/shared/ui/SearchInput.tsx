import type { InputHTMLAttributes } from 'react';
import { Search } from 'lucide-react';

import { NeumorphicTextField } from './NeumorphicTextField';
import styles from './SearchInput.module.css';

interface SearchInputProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'children' | 'type' | 'value'> {
  'aria-label': string;
  value: string;
  onClear: () => void;
  clearLabel: string;
}

export function SearchInput({ className, placeholder = 'Search…', ...props }: SearchInputProps) {
  return <div className={className ? `${styles.root} ${className}` : styles.root}>
    <NeumorphicTextField {...props} variant="standard" type="search" placeholder={placeholder} className={styles.field} />
    <span className={styles.icon} aria-hidden="true"><Search /></span>
  </div>;
}

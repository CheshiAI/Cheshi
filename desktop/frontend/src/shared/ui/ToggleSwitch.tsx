import type { AriaAttributes } from 'react';
import styles from './ToggleSwitch.module.css';

export function ToggleSwitch({ checked, disabled, onChange, ...label }: {
  checked: boolean;
  disabled?: boolean;
  onChange: (checked: boolean) => void;
} & Pick<AriaAttributes, 'aria-label' | 'aria-labelledby'>) {
  return <button {...label} type="button" className={styles.switch} role="switch"
    aria-checked={checked} disabled={disabled} onClick={() => onChange(!checked)}>
    <span aria-hidden="true" />
  </button>;
}

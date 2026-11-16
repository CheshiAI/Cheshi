import { product } from '../../product';
import settings from './SettingsView.module.css';
import styles from './AboutSettings.module.css';

const logo = new URL('../../../../../resources/icons/about-logo.png', import.meta.url).href;
const changelogUrl = 'https://github.com/CheshiAI/Cheshi/blob/main/CHANGELOG.md';

export function AboutSettings() {
  const buildNumber = product.buildNumber.padStart(4, '0');
  const version = `version v${product.version} · build ${buildNumber}`.toLowerCase();

  return <section className={`${settings.detail} ${styles.page}`} aria-labelledby="about-heading">
    <div className={styles.content}>
      <div className={styles.brand}>
        <img className={styles.logo} src={logo} alt="" draggable={false} />
        <h2 id="about-heading">{product.displayName.toUpperCase()}</h2>
      </div>
      <p className={styles.version}>{version}</p>
      <p className={styles.copyright}>© {new Date().getFullYear()} {product.publisher}</p>
      <a className={styles.changelog} href={changelogUrl} target="_blank" rel="noopener noreferrer">Changelog</a>
    </div>
  </section>;
}

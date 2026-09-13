import { Check, ChevronRight } from 'lucide-react';
import { useEffect, useState, type CSSProperties } from 'react';

import { NeumorphicButton } from '../../shared/ui';
import { useHorizontalOverflow } from '../../shared/useHorizontalOverflow';
import {
  cheshiDesktop as desktopApi,
  type CodexPluginLogo,
  type CodexPluginSummary,
} from '../../cheshiDesktop';
import { pluginBrandColor, pluginInitial } from './model';
import styles from './PluginsView.module.css';

const pluginLogoCache = new Map<string, Promise<CodexPluginLogo>>();

type PluginBrandStyle = CSSProperties & { '--plugin-brand': string };

function requestPluginLogo(plugin: CodexPluginSummary): Promise<CodexPluginLogo> | null {
  if (!plugin.hasLogo || !desktopApi?.getCodexPluginLogo) return null;
  const cached = pluginLogoCache.get(plugin.id);
  if (cached) return cached;
  const request = desktopApi.getCodexPluginLogo(plugin.id)
    .catch(() => ({ light: null, dark: null }));
  pluginLogoCache.set(plugin.id, request);
  return request;
}

function usePluginLogo(plugin: CodexPluginSummary): CodexPluginLogo | null {
  const [logo, setLogo] = useState<CodexPluginLogo | null>(null);
  useEffect(() => {
    let current = true;
    setLogo(null);
    const request = requestPluginLogo(plugin);
    if (request) void request.then((value) => {
      if (current) setLogo(value);
    });
    return () => {
      current = false;
    };
  }, [plugin.hasLogo, plugin.id]);
  return logo;
}

export function PluginMark({ plugin, compact = false }: {
  plugin: CodexPluginSummary;
  compact?: boolean;
}) {
  const brandStyle: PluginBrandStyle = { '--plugin-brand': pluginBrandColor(plugin) };
  const logo = usePluginLogo(plugin);
  const [lightFailed, setLightFailed] = useState(false);
  const [darkFailed, setDarkFailed] = useState(false);
  useEffect(() => {
    setLightFailed(false);
    setDarkFailed(false);
  }, [logo]);
  const showLogo = Boolean(logo?.light) && !lightFailed;
  const showDarkLogo = Boolean(logo?.dark) && !darkFailed;
  return (
    <span
      className={styles.pluginMark}
      data-compact={compact ? 'true' : undefined}
      data-dark-logo={showDarkLogo ? 'true' : undefined}
      data-has-logo={showLogo ? 'true' : undefined}
      style={brandStyle}
      aria-hidden="true"
    >
      {showLogo && logo?.light ? (
        <>
          <img className={styles.pluginLogoLight} src={logo.light} alt="" draggable={false} onError={() => setLightFailed(true)} />
          {logo.dark && <img className={styles.pluginLogoDark} src={logo.dark} alt="" draggable={false} onError={() => setDarkFailed(true)} />}
        </>
      ) : pluginInitial(plugin)}
    </span>
  );
}

function PluginCard({ plugin, selected, onSelect }: {
  plugin: CodexPluginSummary;
  selected: boolean;
  onSelect: (plugin: CodexPluginSummary) => void;
}) {
  return (
    <NeumorphicButton
      raised
      active={selected}
      className={styles.pluginCard}
      aria-pressed={selected}
      onClick={() => onSelect(plugin)}
    >
      <span className={styles.pluginCardHeading}>
        <PluginMark plugin={plugin} />
        <span className={styles.pluginCardTitle}>
          <strong>{plugin.displayName}</strong>
          <span>{plugin.developerName}</span>
        </span>
        {plugin.installed && <span className={styles.installedBadge}><Check aria-hidden="true" />Installed</span>}
      </span>
      <span className={styles.pluginCardDescription}>
        {plugin.shortDescription || plugin.longDescription || 'Codex plugin'}
      </span>
      <span className={styles.pluginCardFooter}>
        <span>{plugin.category}</span>
        <span>{plugin.marketplaceDisplayName}<ChevronRight aria-hidden="true" /></span>
      </span>
    </NeumorphicButton>
  );
}

export function PluginGrid({ plugins, selectedId, onSelect }: {
  plugins: readonly CodexPluginSummary[];
  selectedId: string | null;
  onSelect: (plugin: CodexPluginSummary) => void;
}) {
  return (
    <div className={styles.pluginGrid}>
      {plugins.map((plugin) => (
        <PluginCard plugin={plugin} selected={plugin.id === selectedId} key={plugin.id} onSelect={onSelect} />
      ))}
    </div>
  );
}

export function InstalledPluginTile({ plugin, selected, onSelect }: {
  plugin: CodexPluginSummary;
  selected: boolean;
  onSelect: (plugin: CodexPluginSummary) => void;
}) {
  const { overflow, ref: labelRef } = useHorizontalOverflow<HTMLSpanElement>(plugin.displayName);

  return (
    <NeumorphicButton
      raised
      active={selected}
      className={styles.installedTile}
      title={overflow > 0 ? plugin.displayName : undefined}
      onClick={() => onSelect(plugin)}
    >
      <PluginMark compact plugin={plugin} />
      <span ref={labelRef}>{plugin.displayName}</span>
    </NeumorphicButton>
  );
}

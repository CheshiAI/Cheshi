import {
  AlertTriangle,
  Blocks,
  Check,
  Download,
  ExternalLink,
  LoaderCircle,
  Plug,
  ShieldCheck,
  Trash2,
  Wrench,
  X,
} from 'lucide-react';

import { LoadingState, NeumorphicButton } from '../../shared/ui';
import { canInstallPlugin, canUninstallPlugin } from './model';
import { PluginMark } from './PluginDirectoryCards';
import styles from './PluginsView.module.css';
import type { PluginsController } from './usePluginsController';

function humanizeStatus(value: string): string {
  return value.toLocaleLowerCase().replaceAll('_', ' ').replace(/^./, (character) => character.toLocaleUpperCase());
}

export function PluginDetails({ controller }: { controller: PluginsController }) {
  const {
    actionNotice,
    appsNeedingAuth,
    closeDetails,
    confirmationAction,
    detail,
    detailError,
    detailLoading,
    mutatePlugin,
    mutating,
    selected,
    setConfirmationAction,
  } = controller;

  if (!selected) return null;

  return (
    <aside className={styles.details} aria-label="Plugin details">
      <header className={styles.detailsHeader}>
        <div className={styles.detailsIdentity}>
          <PluginMark plugin={selected} />
          <div><strong>{selected.displayName}</strong><span>{selected.developerName}</span></div>
        </div>
        <NeumorphicButton raised className={`theme-toggle ${styles.closeDetails}`} aria-label="Close plugin details" onClick={closeDetails}>
          <X aria-hidden="true" />
        </NeumorphicButton>
      </header>

      <div
        className={styles.detailsContent}
        data-loading={detailLoading ? 'true' : undefined}
        aria-busy={detailLoading}
      >
        {detailLoading && <LoadingState />}
        {!detailLoading && detailError && <div className={styles.detailError} role="alert"><AlertTriangle aria-hidden="true" />{detailError}</div>}

        {!detailLoading && selected && (
          <>
            <p className={styles.detailsDescription}>
              {detail ? detail.description : selected.longDescription || selected.shortDescription}
            </p>
            <div className={styles.detailBadges}>
              <span className={styles.detailBadge}>{selected.category}</span>
              <span className={styles.detailBadge}>{humanizeStatus(selected.source)}</span>
              {(selected.localVersion ?? selected.version) && <span className={styles.detailBadge}>v{selected.localVersion ?? selected.version}</span>}
              {selected.installed && <span className={styles.detailBadge} data-status="installed"><Check aria-hidden="true" />Installed</span>}
            </div>

            {detail && (
              <>
                <div className={styles.capabilitySummary}>
                  <div><Wrench aria-hidden="true" /><strong>{detail.skills.length}</strong><span>Skills</span></div>
                  <div><Plug aria-hidden="true" /><strong>{detail.apps.length}</strong><span>Apps</span></div>
                  <div><Blocks aria-hidden="true" /><strong>{detail.mcpServers.length}</strong><span>MCP</span></div>
                </div>

                {selected.capabilities.length > 0 && (
                  <section className={styles.detailSection}>
                    <h3>Capabilities</h3>
                    <div className={styles.chips}>{selected.capabilities.map((capability) => <span className={styles.detailBadge} key={capability}>{capability}</span>)}</div>
                  </section>
                )}

                {detail.skills.length > 0 && (
                  <section className={styles.detailSection}>
                    <h3>Skills</h3>
                    <div className={styles.detailList}>
                      {detail.skills.map((skill) => (
                        <div key={skill.name}><Wrench aria-hidden="true" /><span><strong>{skill.displayName}</strong><small>{skill.description}</small></span></div>
                      ))}
                    </div>
                  </section>
                )}

                {detail.apps.length > 0 && (
                  <section className={styles.detailSection}>
                    <h3>Apps and connections</h3>
                    <div className={styles.detailList}>
                      {detail.apps.map((app) => (
                        <div key={app.id}>
                          <Plug aria-hidden="true" />
                          <span><strong>{app.name}</strong><small>{app.description || app.category}</small></span>
                          {app.installUrl && <a href={app.installUrl} target="_blank" rel="noreferrer">Connect<ExternalLink aria-hidden="true" /></a>}
                        </div>
                      ))}
                    </div>
                  </section>
                )}

                {detail.mcpServers.length > 0 && (
                  <section className={styles.detailSection}>
                    <h3>MCP servers</h3>
                    <div className={styles.chips}>{detail.mcpServers.map((server) => <span key={server}>{server}</span>)}</div>
                  </section>
                )}

                {(detail.hooks.length > 0 || detail.scheduledTasks.length > 0) && (
                  <section className={styles.detailSection}>
                    <h3>Automation</h3>
                    <div className={styles.automationSummary}>
                      {detail.hooks.length > 0 && <span className={styles.detailBadge}>{detail.hooks.length} hooks</span>}
                      {detail.scheduledTasks.length > 0 && <span className={styles.detailBadge}>{detail.scheduledTasks.length} scheduled tasks</span>}
                    </div>
                  </section>
                )}

                {detail.shareUrl && (
                  <a className={styles.shareLink} href={detail.shareUrl} target="_blank" rel="noreferrer">
                    View plugin page <ExternalLink aria-hidden="true" />
                  </a>
                )}
              </>
            )}

            {appsNeedingAuth.length > 0 && (
              <section className={styles.authNotice}>
                <ShieldCheck aria-hidden="true" />
                <div><strong>Connection required</strong><span>Connect the app before using this plugin.</span></div>
                {appsNeedingAuth.map((app) => app.installUrl && (
                  <a href={app.installUrl} target="_blank" rel="noreferrer" key={app.id}>{app.name}<ExternalLink aria-hidden="true" /></a>
                ))}
              </section>
            )}

            {actionNotice && <div className={styles.actionNotice} role="status">{actionNotice}</div>}
          </>
        )}
      </div>

      {selected && (
        <footer className={styles.detailsFooter}>
          {confirmationAction ? (
            <div className={styles.confirmation}>
              <strong>{confirmationAction === 'install' ? `Install ${selected.displayName}?` : `Remove ${selected.displayName}?`}</strong>
              <span>{confirmationAction === 'install' ? 'This can add skills, apps, MCP servers, hooks, and scheduled tasks.' : 'Its capabilities will no longer be available to new chats.'}</span>
              <div>
                <NeumorphicButton raised disabled={mutating} onClick={() => setConfirmationAction(null)}>Cancel</NeumorphicButton>
                <NeumorphicButton raised className={confirmationAction === 'uninstall' ? styles.dangerButton : styles.primaryButton} disabled={mutating} onClick={() => void mutatePlugin(confirmationAction)}>
                  {mutating ? <LoaderCircle className={styles.spinning} aria-hidden="true" /> : confirmationAction === 'install' ? <Download aria-hidden="true" /> : <Trash2 aria-hidden="true" />}
                  {confirmationAction === 'install' ? 'Install' : 'Remove'}
                </NeumorphicButton>
              </div>
            </div>
          ) : canInstallPlugin(selected) ? (
            <NeumorphicButton raised className={styles.primaryButton} disabled={mutating || detailLoading} onClick={() => setConfirmationAction('install')}>
              <Download aria-hidden="true" />Install plugin
            </NeumorphicButton>
          ) : canUninstallPlugin(selected) ? (
            <NeumorphicButton raised className={styles.removeButton} disabled={mutating || detailLoading} onClick={() => setConfirmationAction('uninstall')}>
              <Trash2 aria-hidden="true" />Remove plugin
            </NeumorphicButton>
          ) : selected.installPolicy === 'INSTALLED_BY_DEFAULT' ? (
            <NeumorphicButton raised disabled><ShieldCheck aria-hidden="true" />Included with Codex</NeumorphicButton>
          ) : (
            <NeumorphicButton raised disabled><AlertTriangle aria-hidden="true" />{selected.disabledReason ? humanizeStatus(selected.disabledReason) : 'Unavailable'}</NeumorphicButton>
          )}
        </footer>
      )}
    </aside>
  );
}

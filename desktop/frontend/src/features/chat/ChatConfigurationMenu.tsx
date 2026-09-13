import { AlertCircle, Check, ChevronRight } from 'lucide-react';
import { createPortal } from 'react-dom';

import { LiquidGlassPanel, LoadingIndicator } from '../../shared/ui';
import { formatReasoningEffort } from './chatViewModel';
import styles from './ChatView.module.css';
import type { ChatViewController } from './useChatViewController';

type ConfigurationMenuController = Pick<ChatViewController,
  | 'chatConfiguration' | 'configurationError' | 'configurationLoading' | 'configurationMenuOpen'
  | 'configurationMenuPosition' | 'configurationMenuRef' | 'configurationMenuView' | 'configurationMenuId'
  | 'fastTier' | 'models' | 'selectComposerModel' | 'selectComposerReasoningEffort'
  | 'selectComposerServiceTier' | 'setConfigurationMenuView'>;

export function ChatConfigurationMenu({ controller }: { controller: ConfigurationMenuController }) {
  if (!controller.configurationMenuOpen || !controller.configurationMenuPosition) return null;
  return createPortal(<ChatConfigurationMenuContent controller={controller} />, document.body);
}

export function ChatConfigurationMenuContent({ controller }: { controller: ConfigurationMenuController }) {
  const {
    chatConfiguration,
    configurationError,
    configurationLoading,
    configurationMenuPosition,
    configurationMenuRef,
    configurationMenuView,
    fastTier,
    models,
    selectComposerModel,
    selectComposerReasoningEffort,
    selectComposerServiceTier,
    setConfigurationMenuView,
  } = controller;

  if (!configurationMenuPosition) return null;
  const saving = configurationLoading && chatConfiguration !== null;

  return (
    <div
      className={styles.configurationPopoverAnchor}
      data-submenu-side={configurationMenuPosition.submenuSide}
      data-saving={saving ? 'true' : undefined}
      ref={configurationMenuRef}
      style={{
        bottom: configurationMenuPosition.bottom,
        left: configurationMenuPosition.left,
        width: configurationMenuPosition.width,
      }}
    >
      {configurationMenuView !== 'root' && (
        <LiquidGlassPanel
          as="section"
          aria-busy={configurationLoading}
          aria-label={configurationMenuView === 'models'
            ? 'Model options'
            : configurationMenuView === 'reasoning'
              ? 'Reasoning effort options'
              : 'Service tier options'}
          className={styles.configurationSubmenu}
          data-liquid-glass-surface="side-panel"
          data-liquid-glass-backdrop="true"
        >
          <strong className={styles.configurationSubmenuTitle}>
            {configurationMenuView === 'models'
              ? 'Model'
              : configurationMenuView === 'reasoning'
                ? 'Reasoning effort'
                : 'Service tier'}
          </strong>
          <div className={styles.configurationOptions} role="listbox">
            {configurationMenuView === 'models' && models.map((model) => (
              <button
                aria-selected={chatConfiguration?.model === model.model}
                className={styles.configurationOption}
                disabled={configurationLoading}
                key={model.id}
                role="option"
                title={model.description}
                type="button"
                onClick={() => void selectComposerModel(model)}
              >
                <span className={styles.configurationOptionCopy}>
                  <strong>{model.displayName}</strong>
                  <span>{model.description}</span>
                </span>
                {chatConfiguration?.model === model.model && <Check aria-hidden="true" />}
              </button>
            ))}
            {configurationMenuView === 'reasoning' && chatConfiguration?.supportedReasoningEfforts.map((option) => (
              <button
                aria-selected={chatConfiguration.reasoningEffort === option.effort}
                className={styles.configurationOption}
                disabled={configurationLoading}
                key={option.effort}
                role="option"
                title={option.description}
                type="button"
                onClick={() => void selectComposerReasoningEffort(option)}
              >
                <span className={styles.configurationOptionCopy}>
                  <strong>{formatReasoningEffort(option.effort)}</strong>
                  <span>{option.description}</span>
                </span>
                {chatConfiguration.reasoningEffort === option.effort && <Check aria-hidden="true" />}
              </button>
            ))}
            {configurationMenuView === 'service-tier' && (
              <>
                <button
                  aria-selected={!chatConfiguration?.fastModeEnabled}
                  className={styles.configurationOption}
                  disabled={configurationLoading}
                  role="option"
                  type="button"
                  onClick={() => void selectComposerServiceTier(false)}
                >
                  <span className={styles.configurationOptionCopy}>
                    <strong>Standard</strong>
                    <span>Default response speed and usage</span>
                  </span>
                  {!chatConfiguration?.fastModeEnabled && <Check aria-hidden="true" />}
                </button>
                <button
                  aria-disabled={!chatConfiguration?.fastModeAvailable}
                  data-unavailable={!chatConfiguration?.fastModeAvailable}
                  aria-selected={chatConfiguration?.fastModeEnabled === true}
                  className={styles.configurationOption}
                  disabled={configurationLoading || !chatConfiguration?.fastModeAvailable}
                  role="option"
                  title={fastTier?.description ?? 'Fast service tier is unavailable for this model'}
                  type="button"
                  onClick={() => void selectComposerServiceTier(true)}
                >
                  <span className={styles.configurationOptionCopy}>
                    <strong>{fastTier?.name ?? 'Fast'}</strong>
                    <span>{fastTier?.description ?? 'Unavailable for this model'}</span>
                  </span>
                  {chatConfiguration?.fastModeEnabled && <Check aria-hidden="true" />}
                </button>
              </>
            )}
          </div>
        </LiquidGlassPanel>
      )}
      <LiquidGlassPanel
        as="section"
        aria-busy={configurationLoading}
        aria-label="Chat configuration"
        className={styles.configurationMenu}
        data-liquid-glass-surface="side-panel"
        id={controller.configurationMenuId}
        role="menu"
      >
        <button
          aria-expanded={configurationMenuView === 'models'}
          aria-haspopup="listbox"
          data-unavailable={models.length === 0}
          className={styles.configurationMenuRow}
          data-active={configurationMenuView === 'models' ? 'true' : undefined}
          disabled={configurationLoading || models.length === 0}
          role="menuitem"
          type="button"
          onClick={() => setConfigurationMenuView('models')}
        >
          <span>Model</span>
          <span className={styles.configurationMenuValue}>{chatConfiguration?.modelDisplayName ?? 'Default model'}</span>
          <span className={styles.configurationMenuIndicator}>
            {saving ? <LoadingIndicator label="Saving configuration" /> : <ChevronRight aria-hidden="true" />}
          </span>
        </button>
        <button
          aria-expanded={configurationMenuView === 'reasoning'}
          aria-haspopup="listbox"
          data-unavailable={!chatConfiguration?.supportedReasoningEfforts.length}
          className={styles.configurationMenuRow}
          data-active={configurationMenuView === 'reasoning' ? 'true' : undefined}
          disabled={configurationLoading || !chatConfiguration?.supportedReasoningEfforts.length}
          role="menuitem"
          type="button"
          onClick={() => setConfigurationMenuView('reasoning')}
        >
          <span>Reasoning</span>
          <span className={styles.configurationMenuValue}>
            {chatConfiguration ? formatReasoningEffort(chatConfiguration.reasoningEffort) : 'Default'}
          </span>
          <ChevronRight aria-hidden="true" />
        </button>
        <button
          aria-expanded={configurationMenuView === 'service-tier'}
          aria-haspopup="listbox"
          data-unavailable={!chatConfiguration}
          className={styles.configurationMenuRow}
          data-active={configurationMenuView === 'service-tier' ? 'true' : undefined}
          disabled={configurationLoading || !chatConfiguration}
          role="menuitem"
          type="button"
          onClick={() => setConfigurationMenuView('service-tier')}
        >
          <span>Service tier</span>
          <span className={styles.configurationMenuValue}>{chatConfiguration?.serviceTierDisplayName ?? 'Standard'}</span>
          <ChevronRight aria-hidden="true" />
        </button>
        {configurationLoading && !chatConfiguration && (
          <div className={styles.configurationMenuStatus}>
            <LoadingIndicator />
            <span>Loading configuration…</span>
          </div>
        )}
        {configurationError && (
          <div className={styles.configurationMenuError} role="alert">
            <AlertCircle aria-hidden="true" />
            <span>{configurationError}</span>
          </div>
        )}
      </LiquidGlassPanel>
    </div>
  );
}

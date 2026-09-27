import { Bot, ChevronDown, Paperclip, Sparkles, X, Zap } from 'lucide-react';
import { LoadingIndicator, NeumorphicButton } from '../../shared/ui';
import { ChatPermissionSelect } from './ChatPermissionSelect';
import { ChatSubmitButton } from './ChatSubmitButton';
import { formatReasoningEffort } from './chatViewModel';
import type { ChatController } from './useChatController';
import type { ChatViewController } from './useChatViewController';
import styles from './ChatComposer.module.css';

export function ChatComposerToolbar({ controller, chatController }: {
  controller: ChatViewController; chatController: ChatController;
}) {
  const {
    attachmentError,
    attachmentPickerOpen,
    cancelResponse,
    chatConfiguration,
    commandLoading,
    commandMenuOpen,
    configurationControlsDisabled,
    configurationLoading,
    configurationMenuOpen,
    configurationTriggerRef,
    draft,
    goalEditorOpen,
    interactionsLocked,
    loading,
    selectAttachments,
    selectedSkill,
    setSelectedSkill,
    streaming,
    toggleConfigurationMenu,
  } = controller;

  return (
    <div className={styles.composerFooter} data-configuration-pending={chatController.configurationPending || undefined}>
      <div className={styles.composerMeta}>
        <NeumorphicButton
          variant="standard"
          size="icon"
          aria-label="Attach files"
          className={styles.attachmentButton}
          disabled={interactionsLocked || loading || commandMenuOpen || attachmentPickerOpen || controller.attachmentTransfer.loading || controller.sendPending}
          title="Attach files"
          onClick={() => void selectAttachments()}
        >
          {attachmentPickerOpen
            ? <LoadingIndicator label="Opening attachment picker" />
            : <Paperclip aria-hidden="true" />}
        </NeumorphicButton>
        <ChatPermissionSelect controller={chatController} disabled={configurationControlsDisabled}
          permissionPending={chatController.configurationPending} />
        {controller.attachmentTransfer.loading && <span role="status">Adding attachments…</span>}
        {attachmentError && (
          <span className={styles.attachmentError} role="alert" title={attachmentError}>
            {attachmentError}
          </span>
        )}
        {selectedSkill && (
          <NeumorphicButton variant="standard"
            aria-label={`Remove ${selectedSkill.displayName} skill`}
            className={styles.skillChip}
            title={selectedSkill.path}
            type="button"
            onClick={() => setSelectedSkill(null)}
          >
            <Sparkles aria-hidden="true" />
            <span>{selectedSkill.displayName}</span>
            <X aria-hidden="true" />
          </NeumorphicButton>
        )}
      </div>
      <div className={styles.composerActions}>
        <div className={styles.configurationTriggerAnchor} ref={configurationTriggerRef}>
          <NeumorphicButton
            active={configurationMenuOpen}
            variant="standard"
            aria-controls={configurationMenuOpen ? controller.configurationMenuId : undefined}
            aria-expanded={configurationMenuOpen}
            aria-haspopup="menu"
            aria-busy={configurationLoading}
            aria-label="Configure model, reasoning effort, and service tier"
            className={styles.configurationTrigger}
            disabled={configurationControlsDisabled}
            title={chatConfiguration
              ? `${chatConfiguration.modelDisplayName} · ${formatReasoningEffort(chatConfiguration.reasoningEffort)} · ${chatConfiguration.serviceTierDisplayName}`
              : 'Chat configuration'}
            onClick={toggleConfigurationMenu}
          >
            {configurationLoading && !chatConfiguration
              ? <LoadingIndicator label="Loading configuration" />
              : chatConfiguration?.fastModeEnabled
                ? <Zap aria-hidden="true" />
                : <Bot aria-hidden="true" />}
            <span className={styles.configurationTriggerModel}>
              {chatConfiguration?.modelDisplayName ?? 'Default model'}
            </span>
            <span className={styles.configurationTriggerEffort}>
              {chatConfiguration ? formatReasoningEffort(chatConfiguration.reasoningEffort) : 'Default'}
            </span>
            <ChevronDown aria-hidden="true" className={styles.configurationChevron} />
          </NeumorphicButton>
        </div>
        <ChatSubmitButton
          streaming={streaming}
          goalEditorOpen={goalEditorOpen}
          onStop={() => void cancelResponse()}
          sendDisabled={
            !draft.trim()
            || interactionsLocked
            || loading
            || chatController.configurationPending
            || attachmentPickerOpen
            || controller.attachmentTransfer.loading
            || commandLoading
            || controller.sendPending
            || (commandMenuOpen && !goalEditorOpen)
          }
        />
      </div>
    </div>
  );
}

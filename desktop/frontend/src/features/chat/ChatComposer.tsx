import { useId, useMemo, useState } from 'react';
import {
  Bot,
  ClipboardList,
  FileText,
  LoaderCircle,
  Paperclip,
  ShieldCheck,
  Sparkles,
  X,
  Zap,
} from 'lucide-react';

import { LiquidGlassPanel, NeumorphicButton, NeumorphicSurface, PillButton, PillDropdownButton } from '../../shared/ui';
import { ChatErrorNotice } from './ChatErrorNotice';
import { attachmentTypeLabel, formatReasoningEffort } from './chatViewModel';
import { ChatCommandMenu } from './ChatCommandMenu';
import { ChatConfigurationMenu } from './ChatConfigurationMenu';
import { ChatInputHistoryPanel } from './ChatInputHistoryPanel';
import { useChatInputHistory } from './useChatInputHistory';
import styles from './ChatView.module.css';
import type { ChatViewController } from './useChatViewController';
import { ChatUserInputRequests } from './ChatUserInputPrompt';
import { ChatPermissionSelect } from './ChatPermissionSelect';
import { ChatSubmitButton } from './ChatSubmitButton';
import type { ChatController } from './useChatController';
import { GithubLinkChips } from './GithubLinkChips';
import { ChatMessageQueue, ChatQueueToggle } from './ChatMessageQueue';
import { ChatFallbackQuestion } from './ChatFallbackQuestion';
import { fallbackQuestionRequest } from './chatQuestionChoices';

export function ChatComposer({ controller, chatController, userInputContextId, active = true }: {
  controller: ChatViewController; chatController: ChatController; userInputContextId?: string; active?: boolean;
}) {
  const {
    answerApproval,
    approvalError,
    approvalLoadingId,
    attachmentError,
    attachmentPickerOpen,
    attachments,
    cancelResponse,
    chatConfiguration,
    commandLoading,
    commandMenuMode,
    commandMenuOpen,
    composerAreaRef,
    configurationControlsDisabled,
    configurationLoading,
    configurationMenuOpen,
    configurationTriggerRef,
    dismissError,
    draft,
    goal,
    goalEditorOpen,
    handleDraftChange,
    handleKeyDown,
    interactionsLocked,
    loading,
    mcpStatusOpen,
    modelPickerOpen,
    pendingApproval,
    permissionsPickerOpen,
    reasoningPickerOpen,
    removeAttachment,
    selectAttachments,
    selectedSkill,
    setSelectedSkill,
    skillPickerOpen,
    state,
    streaming,
    submit,
    textareaRef,
    toggleConfigurationMenu,
  } = controller;
  const agentPickerOpen = controller.agentPickerOpen;
  const queuePanelId = useId();
  const [queueVisible, setQueueVisible] = useState(true);
  const queueOpen = queueVisible && controller.messageQueue.entries.length > 0;
  const fallbackRequest = useMemo(() => fallbackQuestionRequest(state.items, state.activeSessionId), [state.items, state.activeSessionId]);
  const history = useChatInputHistory({ scope: `${chatController.sessionRevision}:${state.activeSessionId ?? ''}`,
    items: state.items, draft, textareaRef, setDraft: controller.setDraft, onKeyDown: handleKeyDown,
    disabled: !active || interactionsLocked || loading || commandMenuOpen || configurationMenuOpen || controller.sendPending || commandLoading });

  return (
    <footer className={styles.composerArea} ref={composerAreaRef} onKeyUp={history.onKeyUp}>
      <ChatUserInputRequests contextId={userInputContextId} activeThreadId={state.activeSessionId}
        fallbackId={fallbackRequest?.id}
        fallback={<ChatFallbackQuestion candidate={fallbackRequest} controller={controller} chatController={chatController} active={active} />} />
      {state.error && (
        <ChatErrorNotice className={styles.error} onDismiss={dismissError}>{state.error}</ChatErrorNotice>
      )}
      {!commandMenuOpen && controller.commandError && <ChatErrorNotice className={styles.error}>{controller.commandError}</ChatErrorNotice>}
      {controller.sendRecovery && <div className={styles.sendRecovery} role="status">
        <span>{controller.sendRecovery.status === 'restored'
          ? 'Not sent. Your draft and attachments were restored. Send again to retry.'
          : controller.sendRecovery.status === 'available'
            ? 'Not sent. Your previous draft is saved. Clear the current draft to restore it.'
            : 'Delivery could not be confirmed. Check this conversation before sending again.'}</span>
        {controller.sendRecovery.status === 'available' && <NeumorphicButton
          disabled={!controller.canRestoreFailedMessage} onClick={controller.restoreFailedMessage}>Restore draft</NeumorphicButton>}
      </div>}
      {pendingApproval && (
        <LiquidGlassPanel
          as="section"
          aria-label={pendingApproval.title}
          className={styles.approvalPrompt}
          data-liquid-glass-backdrop="true"
        >
          <NeumorphicSurface as="span" raised className={styles.approvalIcon}><ShieldCheck aria-hidden="true" /></NeumorphicSurface>
          <div className={styles.approvalCopy}>
            <strong>{pendingApproval.title}</strong>
            <span title={pendingApproval.detail}>{pendingApproval.detail}</span>
            {approvalError && <span className={styles.approvalError} role="alert">{approvalError}</span>}
          </div>
          <div className={styles.approvalActions}>
            <NeumorphicButton
              raised
              size="standard"
              className={styles.approvalAction}
              disabled={approvalLoadingId === pendingApproval.id}
              onClick={() => void answerApproval('decline')}
            >
              Deny
            </NeumorphicButton>
            <NeumorphicButton
              raised
              size="standard"
              className={styles.approvalAction}
              disabled={approvalLoadingId === pendingApproval.id}
              onClick={() => void answerApproval('accept')}
            >
              Allow once
            </NeumorphicButton>
            {pendingApproval.canAllowForSession && (
              <NeumorphicButton
                raised
                size="standard"
                className={styles.approvalAction}
                disabled={approvalLoadingId === pendingApproval.id}
                onClick={() => void answerApproval('acceptForSession')}
              >
                Allow session
              </NeumorphicButton>
            )}
          </div>
        </LiquidGlassPanel>
      )}

      <ChatCommandMenu controller={controller} />
      <ChatConfigurationMenu controller={controller} />

      <ChatMessageQueue controller={controller} open={queueOpen} panelId={queuePanelId} />
      <ChatInputHistoryPanel history={history} />
      <LiquidGlassPanel className={styles.composerSurface} data-queue-open={queueOpen ? 'true' : 'false'} data-liquid-glass-surface="side-panel" data-liquid-glass-backdrop="true">
        <form className={styles.composer} onSubmit={submit}>
          {attachments.length > 0 && (
            <div className={styles.attachmentTray} aria-label="Attached files">
              {attachments.map((attachment) => {
                const showImage = attachment.kind === 'image' && Boolean(attachment.previewUrl);
                return (
                  <div
                    className={`${styles.attachmentCard} ${showImage ? styles.imageAttachmentCard : styles.fileAttachmentCard}`}
                    key={attachment.path}
                    title={attachment.path}
                  >
                    {showImage ? (
                      <img alt={attachment.name} src={attachment.previewUrl} />
                    ) : (
                      <div className={styles.attachmentFileContent}>
                        <FileText aria-hidden="true" />
                        <span>
                          <strong>{attachment.name}</strong>
                          <small>{attachmentTypeLabel(attachment.name)}</small>
                        </span>
                      </div>
                    )}
                    <NeumorphicButton
                      raised
                      aria-label={`Remove ${attachment.name}`}
                      className={`sidebar-heading-action ${styles.attachmentRemove}`}
                      onClick={() => removeAttachment(attachment.path)}
                    >
                      <X aria-hidden="true" />
                    </NeumorphicButton>
                  </div>
                );
              })}
            </div>
          )}
          {!commandMenuOpen && <GithubLinkChips draft={draft} />}
          <textarea
            aria-label={goalEditorOpen ? 'Persistent goal objective' : 'Message Codex'}
            disabled={loading}
            aria-controls={history.open ? history.listId : commandMenuOpen ? controller.commandMenuId : undefined}
            aria-expanded={history.open || commandMenuOpen}
            aria-activedescendant={history.open ? `${history.listId}-${history.state.selected}` : undefined}
            placeholder={skillPickerOpen
              ? 'Search installed skills'
              : agentPickerOpen
                ? 'Search agent threads'
                : modelPickerOpen
                  ? 'Search available models'
                  : reasoningPickerOpen
                    ? 'Search reasoning levels'
                    : permissionsPickerOpen
                      ? 'Search permission modes'
                      : commandMenuMode === 'status'
                        ? 'Current chat status'
                        : mcpStatusOpen
                          ? 'Filter connected MCP servers'
                          : goalEditorOpen
                            ? goal ? 'Replace the persistent goal' : 'Set a persistent goal for this chat'
                            : selectedSkill
                              ? `Ask with ${selectedSkill.displayName}`
                              : streaming ? 'Queue a message for after the current response' : 'Ask Codex about this workspace'}
            ref={textareaRef}
            rows={1}
            value={draft}
            onChange={(event) => { history.close(); handleDraftChange(event.target.value); }}
            onPaste={controller.attachmentTransfer.onPaste}
            onKeyDown={history.onKeyDown}
          />
          <div className={styles.composerFooter} data-configuration-pending={chatController.configurationPending || undefined}>
            <div className={styles.composerMeta}>
              <NeumorphicButton
                raised
                aria-label="Attach files"
                className={`sidebar-heading-action ${styles.attachmentButton}`}
                disabled={interactionsLocked || loading || commandMenuOpen || attachmentPickerOpen || controller.attachmentTransfer.loading || controller.sendPending}
                title="Attach files"
                onClick={() => void selectAttachments()}
              >
                {attachmentPickerOpen
                  ? <LoaderCircle aria-hidden="true" className={styles.attachmentSpinner} />
                  : <Paperclip aria-hidden="true" />}
              </NeumorphicButton>
              <ChatPermissionSelect controller={chatController} disabled={configurationControlsDisabled}
                permissionPending={chatController.configurationPending} />
              <PillButton aria-label="Plan mode" aria-pressed={chatConfiguration?.collaborationMode === 'plan'}
                disabled={configurationControlsDisabled || configurationLoading || !chatConfiguration}
                title={chatConfiguration?.collaborationMode === 'plan' ? 'Turn off Plan mode' : 'Turn on Plan mode'}
                onClick={() => void controller.selectCollaborationMode(chatConfiguration?.collaborationMode === 'plan' ? 'default' : 'plan')}>
                <ClipboardList aria-hidden="true" />
                <span>Plan</span>
              </PillButton>
              {controller.attachmentTransfer.loading && <span role="status">Adding attachments…</span>}
              {attachmentError && (
                <span className={styles.attachmentError} role="alert" title={attachmentError}>
                  {attachmentError}
                </span>
              )}
              {selectedSkill && (
                <button
                  aria-label={`Remove ${selectedSkill.displayName} skill`}
                  className={styles.skillChip}
                  title={selectedSkill.path}
                  type="button"
                  onClick={() => setSelectedSkill(null)}
                >
                  <Sparkles aria-hidden="true" />
                  <span>{selectedSkill.displayName}</span>
                  <X aria-hidden="true" />
                </button>
              )}
            </div>
            <div className={styles.composerActions}>
              <div className={styles.configurationTriggerAnchor} ref={configurationTriggerRef}>
                <PillDropdownButton
                  active={configurationMenuOpen}
                  raised
                  aria-controls={configurationMenuOpen ? controller.configurationMenuId : undefined}
                  aria-expanded={configurationMenuOpen}
                  aria-haspopup="menu"
                  aria-busy={configurationLoading}
                  aria-label="Configure model, reasoning effort, and service tier"
                  className={`neumorphic-surface ${styles.configurationTrigger}`}
                  disabled={configurationControlsDisabled}
                  title={chatConfiguration
                    ? `${chatConfiguration.modelDisplayName} · ${formatReasoningEffort(chatConfiguration.reasoningEffort)} · ${chatConfiguration.serviceTierDisplayName}`
                    : 'Chat configuration'}
                  onClick={toggleConfigurationMenu}
                >
                  {configurationLoading && !chatConfiguration
                    ? <LoaderCircle aria-hidden="true" className={styles.configurationSpinner} />
                    : chatConfiguration?.fastModeEnabled
                      ? <Zap aria-hidden="true" />
                      : <Bot aria-hidden="true" />}
                  <span className={styles.configurationTriggerModel}>
                    {chatConfiguration?.modelDisplayName ?? 'Default model'}
                  </span>
                  <span className={styles.configurationTriggerEffort}>
                    {chatConfiguration ? formatReasoningEffort(chatConfiguration.reasoningEffort) : 'Default'}
                  </span>
                </PillDropdownButton>
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
          <ChatQueueToggle controller={controller} open={queueOpen} panelId={queuePanelId}
            onToggle={() => setQueueVisible((visible) => !visible)} />
        </form>
      </LiquidGlassPanel>
      <p className={styles.disclaimer}>Codex can make mistakes. Check important answers.</p>
    </footer>
  );
}

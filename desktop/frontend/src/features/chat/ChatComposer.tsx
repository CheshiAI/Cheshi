import { useId, useMemo, useState } from 'react';
import { ShieldCheck } from 'lucide-react';

import { ContentCard, LiquidGlassPanel, NeumorphicButton } from '../../shared/ui';
import { ChatErrorNotice } from './ChatErrorNotice';
import { ChatCommandMenu } from './ChatCommandMenu';
import { ChatConfigurationMenu } from './ChatConfigurationMenu';
import { ChatInputHistoryPanel } from './ChatInputHistoryPanel';
import { useChatInputHistory } from './useChatInputHistory';
import styles from './ChatComposer.module.css';
import { ChatComposerAttachments } from './ChatComposerAttachments';
import { ChatComposerToolbar } from './ChatComposerToolbar';
import type { ChatViewController } from './useChatViewController';
import { ChatUserInputRequests } from './ChatUserInputPrompt';
import type { ChatController } from './useChatController';
import { GithubLinkChips } from './GithubLinkChips';
import { ChatMessageQueue, ChatQueueToggle } from './ChatMessageQueue';
import { ChatFallbackQuestion } from './ChatFallbackQuestion';
import { composerQuestionRequest } from './chatQuestionChoices';

export function ChatComposer({ controller, chatController, userInputContextId, active = true }: {
  controller: ChatViewController; chatController: ChatController; userInputContextId?: string; active?: boolean;
}) {
  const {
    answerApproval,
    approvalError,
    approvalLoadingId,
    attachments,
    commandLoading,
    commandMenuMode,
    commandMenuOpen,
    composerAreaRef,
    configurationMenuOpen,
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
    selectedSkill,
    skillPickerOpen,
    state,
    streaming,
    submit,
    textareaRef,
  } = controller;
  const agentPickerOpen = controller.agentPickerOpen;
  const queuePanelId = useId();
  const [queueVisible, setQueueVisible] = useState(true);
  const queueOpen = queueVisible && controller.messageQueue.entries.length > 0;
  const fallbackRequest = useMemo(() => composerQuestionRequest(state.items, state.activeSessionId), [state.items, state.activeSessionId]);
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
        {controller.sendRecovery.status === 'available' && <NeumorphicButton variant="standard"
          disabled={!controller.canRestoreFailedMessage} onClick={controller.restoreFailedMessage}>Restore draft</NeumorphicButton>}
      </div>}
      {pendingApproval && (
        <ContentCard
          as="section"
          aria-label={pendingApproval.title}
          className={styles.approvalPrompt}
          icon={<ShieldCheck aria-hidden="true" />}
          title={pendingApproval.title}
          description={<>
            <span>{pendingApproval.detail}</span>
            {approvalError && <span className={styles.approvalError} role="alert">{approvalError}</span>}
          </>}
          actions={<span className={styles.approvalActions}>
            <NeumorphicButton
              variant="standard"
              size="standard"
              className={styles.approvalAction}
              disabled={approvalLoadingId === pendingApproval.id}
              onClick={() => void answerApproval('decline')}
            >
              Deny
            </NeumorphicButton>
            <NeumorphicButton
              variant="standard"
              size="standard"
              className={styles.approvalAction}
              disabled={approvalLoadingId === pendingApproval.id}
              onClick={() => void answerApproval('accept')}
            >
              Allow once
            </NeumorphicButton>
            {pendingApproval.canAllowForSession && (
              <NeumorphicButton
                variant="standard"
                size="standard"
                className={styles.approvalAction}
                disabled={approvalLoadingId === pendingApproval.id}
                onClick={() => void answerApproval('acceptForSession')}
              >
                Allow session
              </NeumorphicButton>
            )}
          </span>}
        />
      )}

      <ChatCommandMenu controller={controller} />
      <ChatConfigurationMenu controller={controller} />

      <ChatMessageQueue controller={controller} open={queueOpen} panelId={queuePanelId} />
      <ChatInputHistoryPanel history={history} />
      <div className={styles.composerAnchor} data-queue-open={queueOpen ? 'true' : 'false'}>
        <LiquidGlassPanel className={styles.composerSurface} data-liquid-glass-backdrop="true">
          <form className={styles.composer} onSubmit={submit}>
            <ChatComposerAttachments attachments={attachments} removeAttachment={removeAttachment} />
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
            <ChatComposerToolbar controller={controller} chatController={chatController} />
            <ChatQueueToggle controller={controller} open={queueOpen} panelId={queuePanelId}
              onToggle={() => setQueueVisible((visible) => !visible)} />
          </form>
        </LiquidGlassPanel>
      </div>
      <div className={styles.disclaimerRow}>
        <p className={styles.disclaimer}>codex can make mistakes. check important answers.</p>
      </div>
    </footer>
  );
}

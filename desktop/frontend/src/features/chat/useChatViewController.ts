import { createSkillCatalogCache } from './skillCatalogCache';
import {
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type SubmitEvent,
} from 'react';

import { errorMessage } from '../../shared/errorMessage';
import { cheshiDesktop } from '../../cheshiDesktop';
import {
  assertFastModeAvailable,
  chatCommandMenuHelp,
  chatCommandMenuSubtitle,
  chatCommandMenuTitle,
  slashCommands,
  type CommandMenuMode,
  type SlashCommand,
} from './chatViewModel';
import { isViewedSessionResponding } from './model';
import type {
  ChatAgentThread,
  ChatApprovalDecision,
  ChatCommandStatus,
  ChatGoal,
  ChatMcpServer,
  ChatModel,
  ChatPermissionMode,
  ChatReasoningEffort,
  ChatSkill,
} from './model';
import type { ChatController } from './useChatController';
import { useChatConfiguration } from './useChatConfiguration';
import { useChatTaskScope } from './useChatTaskScope';
import { useChatDraft } from './useChatDraft';
import { useChatAttachmentTransfer } from './useChatAttachmentTransfer';
import { mergeChatAttachments } from './attachmentTransferModel';

interface UseChatViewControllerOptions {
  controller: ChatController;
  onNewSession: () => void;
  active?: boolean;
  interactionsLocked?: boolean;
}

export function useChatViewController({ controller, onNewSession, active = true, interactionsLocked = false }: UseChatViewControllerOptions) {
  const {
    state,
    sessionRevision,
    sendMessage,
    listAgents,
    openAgent,
    listSkills,
    listModels,
    listMcpServers,
    listPermissionModes,
    setPermissionMode,
    respondToApproval,
    configureChat,
    getChatStatus,
    getGoal,
    setGoal,
    forkSession,
    compactSession,
    reviewSession,
    cancelResponse,
    dismissError,
  } = controller;
  const captureTask = useChatTaskScope(`${sessionRevision}:${state.activeSessionId ?? ''}`);
  const { draft, setDraft, selectedSkill, setSelectedSkill, attachments, setAttachments,
    pending: sendPending, recovery: sendRecovery, submitDraft, restoreFailedMessage, canRestoreFailedMessage } = useChatDraft(
    sessionRevision, (input) => sendMessage(input.draft, input.selectedSkill, input.attachments));
  const [commandMenuMode, setCommandMenuMode] = useState<CommandMenuMode | null>(null);
  const [agents, setAgents] = useState<ChatAgentThread[]>([]);
  const skillCatalog = useMemo(() => createSkillCatalogCache(listSkills), [listSkills]);
  const [skills, setSkills] = useState<ChatSkill[]>([]);
  const [mcpServers, setMcpServers] = useState<ChatMcpServer[]>([]);
  const [permissionModes, setPermissionModes] = useState<ChatPermissionMode[]>([]);
  const [commandStatus, setCommandStatus] = useState<ChatCommandStatus | null>(null);
  const [goal, setGoalState] = useState<ChatGoal | null>(null);
  const [commandLoading, setCommandLoading] = useState(false);
  const [commandError, setCommandError] = useState<string | null>(null);
  const attachmentPickerPending = useRef(false);
  const [attachmentPickerOpen, setAttachmentPickerOpen] = useState(false);
  const [attachmentError, setAttachmentError] = useState<string | null>(null);
  const [highlightedIndex, setHighlightedIndex] = useState(0);
  const [showScrollToBottom, setShowScrollToBottom] = useState(false);
  const [approvalLoadingId, setApprovalLoadingId] = useState<string | null>(null);
  const [approvalError, setApprovalError] = useState<string | null>(null);
  const rootRef = useRef<HTMLElement>(null);
  const timelineRef = useRef<HTMLElement>(null);
  const composerAreaRef = useRef<HTMLElement>(null);
  const commandOptionsRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const viewId = useId();
  const commandMenuId = `${viewId}-command-menu`;
  const configurationMenuId = `${viewId}-configuration-menu`;
  const {
    chatConfiguration, configurationError, configurationLoading,
    configurationMenuOpen, configurationMenuPosition, configurationMenuRef,
    configurationMenuView, configurationTriggerRef, fastTier, models,
    selectComposerModel, selectComposerReasoningEffort, selectComposerServiceTier,
    setChatConfiguration, setConfigurationMenuOpen, setConfigurationMenuView,
    setModels, toggleConfigurationMenu, focusComposer,
  } = useChatConfiguration({ controller, rootRef, textareaRef, active: active && !interactionsLocked });
  const stickToBottomRef = useRef(true);
  const scrollingToBottomRef = useRef(false);
  const streaming = isViewedSessionResponding(state);
  const loading = state.phase === 'loading';
  const workspaceName = cheshiDesktop?.workspaceName ?? 'Workspace';
  const slashMenuOpen = commandMenuMode === 'commands';
  const agentPickerOpen = commandMenuMode === 'agents';
  const skillPickerOpen = commandMenuMode === 'skills';
  const modelPickerOpen = commandMenuMode === 'models';
  const reasoningPickerOpen = commandMenuMode === 'reasoning';
  const mcpStatusOpen = commandMenuMode === 'mcp';
  const goalEditorOpen = commandMenuMode === 'goal';
  const permissionsPickerOpen = commandMenuMode === 'permissions';
  const commandMenuOpen = commandMenuMode !== null;
  const attachmentTransfer = useChatAttachmentTransfer({
    scopeKey: `${sessionRevision}:${state.activeSessionId ?? ''}`,
    disabled: interactionsLocked || !active || loading || sendPending || commandLoading || commandMenuOpen || attachmentPickerOpen,
    attachments, captureTask,
    importFiles: async (files) => {
      if (attachmentPickerPending.current) throw new Error('Wait for the attachment picker to close.');
      if (!cheshiDesktop?.importCodexChatAttachments) throw new Error('Attachment import is unavailable. Restart the app.');
      return cheshiDesktop.importCodexChatAttachments(files);
    },
    addAttachments: (selected) => setAttachments((current) => mergeChatAttachments(current, selected)),
    onComplete: focusComposer,
  });
  const configurationControlsDisabled = interactionsLocked || loading || streaming || commandLoading || commandMenuOpen
    || sendPending || controller.configurationPending;
  const selectCollaborationMode = async (mode: 'default' | 'plan'): Promise<void> => {
    if (configurationControlsDisabled) return;
    const isCurrent = captureTask();
    setCommandError(null);
    try {
      const configuration = await controller.setCollaborationMode(mode);
      if (isCurrent()) setChatConfiguration(configuration);
    } catch (error) {
      if (isCurrent()) setCommandError(errorMessage(error));
    }
  };
  const pendingApproval = state.approvals.find((approval) => approval.threadId === state.activeSessionId) ?? null;
  const slashQuery = slashMenuOpen ? draft.slice(1).trim().toLocaleLowerCase() : '';
  const pickerQuery = commandMenuMode
    && commandMenuMode !== 'commands'
    && commandMenuMode !== 'status'
    && commandMenuMode !== 'goal'
    ? draft.trim().toLocaleLowerCase()
    : '';
  const filteredCommands = slashCommands.filter((command) => (
    !slashQuery
    || command.name.includes(slashQuery)
    || command.label.toLocaleLowerCase().includes(slashQuery)
  ));
  const filteredAgents = agents.filter((agent) => (
    !pickerQuery
    || [agent.title, agent.description, agent.role ?? '', agent.status]
      .some((value) => value.toLocaleLowerCase().includes(pickerQuery))
  ));
  const filteredSkills = skills.filter((skill) => {
    if (!pickerQuery) return true;
    return [skill.name, skill.displayName, skill.description, skill.scope]
      .some((value) => value.toLocaleLowerCase().includes(pickerQuery));
  });
  const filteredModels = models.filter((model) => (
    !pickerQuery
    || [model.model, model.displayName, model.description]
      .some((value) => value.toLocaleLowerCase().includes(pickerQuery))
  ));
  const filteredReasoningEfforts = (chatConfiguration?.supportedReasoningEfforts ?? []).filter((option) => (
    !pickerQuery
    || [option.effort, option.description]
      .some((value) => value.toLocaleLowerCase().includes(pickerQuery))
  ));
  const filteredMcpServers = mcpServers.filter((server) => (
    !pickerQuery
    || [server.name, server.displayName, server.authStatus]
      .some((value) => value.toLocaleLowerCase().includes(pickerQuery))
  ));
  const filteredPermissionModes = permissionModes.filter((mode) => (
    !pickerQuery
    || [mode.label, mode.description, mode.access]
      .some((value) => value.toLocaleLowerCase().includes(pickerQuery))
  ));
  const visibleOptionCount = commandMenuMode === 'commands'
    ? filteredCommands.length
    : commandMenuMode === 'agents'
      ? filteredAgents.length
      : commandMenuMode === 'skills'
        ? filteredSkills.length
        : commandMenuMode === 'models'
          ? filteredModels.length
          : commandMenuMode === 'reasoning'
            ? filteredReasoningEfforts.length
            : commandMenuMode === 'permissions'
              ? filteredPermissionModes.length
              : 0;
  const commandMenuTitle = chatCommandMenuTitle(commandMenuMode);
  const commandMenuSubtitle = chatCommandMenuSubtitle(commandMenuMode, commandLoading, {
    agents: filteredAgents.length,
    skills: filteredSkills.length,
    models: filteredModels.length,
    reasoning: filteredReasoningEfforts.length,
    mcp: mcpServers.length,
    permissions: filteredPermissionModes.filter((mode) => mode.allowed).length,
  }, goal, commandError);
  const commandMenuHelp = chatCommandMenuHelp(commandMenuMode);

  useLayoutEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    const resize = (): void => {
      textarea.style.height = '0px';
      textarea.style.height = `${Math.min(textarea.scrollHeight, 180)}px`;
    };
    resize();
    let width = textarea.clientWidth;
    const observer = new ResizeObserver(() => {
      if (width === textarea.clientWidth) return;
      width = textarea.clientWidth;
      resize();
    });
    observer.observe(textarea);
    return () => observer.disconnect();
  }, [draft]);

  useLayoutEffect(() => {
    const root = rootRef.current;
    const composerArea = composerAreaRef.current;
    if (!root || !composerArea) return;

    const syncComposerOverlayHeight = (): void => {
      root.style.setProperty('--composer-overlay-height', `${Math.ceil(composerArea.getBoundingClientRect().height)}px`);
    };

    syncComposerOverlayHeight();
    const observer = new ResizeObserver(syncComposerOverlayHeight);
    observer.observe(composerArea);

    return () => {
      observer.disconnect();
      root.style.removeProperty('--composer-overlay-height');
    };
  }, []);

  useEffect(() => {
    if (!active || interactionsLocked) setCommandMenuMode(null);
  }, [active, interactionsLocked]);

  useEffect(() => {
    setHighlightedIndex(0);
  }, [commandMenuMode, draft]);

  useLayoutEffect(() => {
    const options = commandOptionsRef.current;
    const activeOption = options?.querySelector<HTMLElement>('[data-active="true"]');
    if (!options || !activeOption) return;
    const optionsRect = options.getBoundingClientRect();
    const activeRect = activeOption.getBoundingClientRect();
    if (activeRect.top < optionsRect.top) options.scrollTop -= optionsRect.top - activeRect.top;
    if (activeRect.bottom > optionsRect.bottom) options.scrollTop += activeRect.bottom - optionsRect.bottom;
  }, [commandLoading, commandMenuMode, draft, highlightedIndex, visibleOptionCount]);

  useEffect(() => {
    setCommandLoading(false);
    setAttachmentPickerOpen(false);
    setAttachmentError(null);
    setCommandMenuMode(null);
    setConfigurationMenuOpen(false);
    setConfigurationMenuView('root');
  }, [sessionRevision, state.activeSessionId]);

  useEffect(() => {
    setApprovalError(null);
    setApprovalLoadingId(null);
  }, [pendingApproval?.id]);

  useEffect(() => {
    const timeline = timelineRef.current;
    if (!timeline) return;

    const syncScrollPosition = (): void => {
      const distanceFromBottom = timeline.scrollHeight - timeline.scrollTop - timeline.clientHeight;
      const nearBottom = distanceFromBottom <= 48;
      if (scrollingToBottomRef.current) {
        if (nearBottom) scrollingToBottomRef.current = false;
        stickToBottomRef.current = true;
        setShowScrollToBottom(false);
        return;
      }
      stickToBottomRef.current = nearBottom;
      setShowScrollToBottom(!nearBottom);
    };

    syncScrollPosition();
    timeline.addEventListener('scroll', syncScrollPosition, { passive: true });
    return () => timeline.removeEventListener('scroll', syncScrollPosition);
  }, []);

  useEffect(() => {
    stickToBottomRef.current = true;
    scrollingToBottomRef.current = false;
    setShowScrollToBottom(false);
  }, [state.activeSessionId, loading]);

  useLayoutEffect(() => {
    const timeline = timelineRef.current;
    if (!timeline || !stickToBottomRef.current) return;
    timeline.scrollTo({ top: timeline.scrollHeight });
    setShowScrollToBottom(false);
  }, [state.items]);

  const pauseAutoScroll = (): void => {
    scrollingToBottomRef.current = false;
  };

  const scrollToBottom = (): void => {
    const timeline = timelineRef.current;
    if (!timeline) return;
    stickToBottomRef.current = true;
    scrollingToBottomRef.current = true;
    setShowScrollToBottom(false);
    timeline.scrollTo({ top: timeline.scrollHeight, behavior: 'smooth' });
  };

  const scrollToHistoryItem = (item: HTMLElement): void => {
    stickToBottomRef.current = false;
    scrollingToBottomRef.current = false;
    item.scrollIntoView({ block: 'center', behavior: 'instant' });
    item.focus({ preventScroll: true });
    const timeline = timelineRef.current;
    setShowScrollToBottom(Boolean(timeline && timeline.scrollHeight - timeline.scrollTop - timeline.clientHeight > 48));
  };

  const selectSkill = (skill: ChatSkill): void => {
    setSelectedSkill(skill);
    setCommandMenuMode(null);
    setCommandError(null);
    setDraft('');
    focusComposer();
  };

  const closeCommandMenu = (): void => {
    setCommandMenuMode(null);
    setCommandError(null);
    setDraft('');
    focusComposer();
  };

  const selectAgent = async (agent: ChatAgentThread): Promise<void> => {
    if (agent.current) {
      closeCommandMenu();
      return;
    }
    setCommandLoading(true);
    setCommandError(null);
    try {
      await openAgent(agent.id);
      setCommandMenuMode(null);
      setDraft('');
    } catch (error) {
      setCommandError(errorMessage(error));
    } finally {
      setCommandLoading(false);
      focusComposer();
    }
  };

  const openAgentPicker = async (): Promise<void> => {
    const isCurrent = captureTask();
    setCommandMenuMode('agents');
    setAgents([]);
    setCommandLoading(true);
    setCommandError(null);
    setDraft('');
    try {
      const result = await listAgents();
      if (!isCurrent()) return;
      setAgents(result);
    } catch (error) {
      if (!isCurrent()) return;
      setAgents([]);
      setCommandError(errorMessage(error));
    } finally {
      if (isCurrent()) {
        setCommandLoading(false);
        focusComposer();
      }
    }
  };

  const openSkillPicker = async (): Promise<void> => {
    const isCurrent = captureTask();
    setCommandMenuMode('skills');
    const cached = skillCatalog.peek();
    setSkills(cached ?? []);
    setCommandLoading(cached === undefined);
    setCommandError(null);
    setDraft('');
    try {
      const result = await skillCatalog.read();
      if (!isCurrent()) return;
      setSkills(result);
    } catch (error) {
      if (!isCurrent()) return;
      setSkills([]);
      setCommandError(errorMessage(error));
    } finally {
      if (isCurrent()) {
        setCommandLoading(false);
        focusComposer();
      }
    }
  };

  const openModelPicker = async (mode: 'models' | 'reasoning'): Promise<void> => {
    const isCurrent = captureTask();
    setCommandMenuMode(mode);
    setModels([]);
    setChatConfiguration(null);
    setCommandLoading(true);
    setCommandError(null);
    setDraft('');
    try {
      const catalog = await listModels();
      if (!isCurrent()) return;
      setModels(catalog.models);
      setChatConfiguration(catalog.configuration);
    } catch (error) {
      if (!isCurrent()) return;
      setModels([]);
      setCommandError(errorMessage(error));
    } finally {
      if (isCurrent()) {
        setCommandLoading(false);
        focusComposer();
      }
    }
  };

  const openStatus = async (): Promise<void> => {
    const isCurrent = captureTask();
    setCommandMenuMode('status');
    setCommandStatus(null);
    setCommandLoading(true);
    setCommandError(null);
    setDraft('');
    try {
      const catalog = await listModels();
      if (!isCurrent()) return;
      setModels(catalog.models);
      setChatConfiguration(catalog.configuration);
      const result = await getChatStatus();
      if (!isCurrent()) return;
      setCommandStatus(result);
    } catch (error) {
      if (!isCurrent()) return;
      setCommandError(errorMessage(error));
    } finally {
      if (isCurrent()) {
        setCommandLoading(false);
        focusComposer();
      }
    }
  };

  const openMcpStatus = async (): Promise<void> => {
    const isCurrent = captureTask();
    setCommandMenuMode('mcp');
    setMcpServers([]);
    setCommandLoading(true);
    setCommandError(null);
    setDraft('');
    try {
      const result = await listMcpServers();
      if (!isCurrent()) return;
      setMcpServers(result);
    } catch (error) {
      if (!isCurrent()) return;
      setMcpServers([]);
      setCommandError(errorMessage(error));
    } finally {
      if (isCurrent()) {
        setCommandLoading(false);
        focusComposer();
      }
    }
  };

  const openPermissions = async (): Promise<void> => {
    const isCurrent = captureTask();
    setCommandMenuMode('permissions');
    setPermissionModes([]);
    setCommandLoading(true);
    setCommandError(null);
    setDraft('');
    try {
      const response = await listPermissionModes();
      if (!isCurrent()) return;
      setPermissionModes(response.modes);
    } catch (error) {
      if (!isCurrent()) return;
      setPermissionModes([]);
      setCommandError(errorMessage(error));
    } finally {
      if (isCurrent()) {
        setCommandLoading(false);
        focusComposer();
      }
    }
  };

  const openGoalEditor = async (): Promise<void> => {
    const isCurrent = captureTask();
    setCommandMenuMode('goal');
    setGoalState(null);
    setCommandLoading(true);
    setCommandError(null);
    setDraft('');
    try {
      const result = await getGoal();
      if (!isCurrent()) return;
      setGoalState(result);
    } catch (error) {
      if (!isCurrent()) return;
      setCommandError(errorMessage(error));
    } finally {
      if (isCurrent()) {
        setCommandLoading(false);
        focusComposer();
      }
    }
  };

  const saveGoal = async (): Promise<void> => {
    const isCurrent = captureTask();
    const objective = draft.trim();
    if (!objective || commandLoading || streaming || loading) return;
    setCommandLoading(true);
    setCommandError(null);
    try {
      const result = await setGoal(objective);
      if (!isCurrent()) return;
      setGoalState(result);
      setCommandMenuMode(null);
      setDraft('');
    } catch (error) {
      if (!isCurrent()) return;
      setCommandError(errorMessage(error));
    } finally {
      if (isCurrent()) {
        setCommandLoading(false);
        focusComposer();
      }
    }
  };

  const selectModel = async (model: ChatModel): Promise<void> => {
    const isCurrent = captureTask();
    setCommandLoading(true);
    setCommandError(null);
    try {
      const result = await configureChat({ model: model.model });
      if (!isCurrent()) return;
      setChatConfiguration(result);
      setCommandMenuMode(null);
      setDraft('');
    } catch (error) {
      if (!isCurrent()) return;
      setCommandError(errorMessage(error));
    } finally {
      if (isCurrent()) {
        setCommandLoading(false);
        focusComposer();
      }
    }
  };

  const selectReasoningEffort = async (option: ChatReasoningEffort): Promise<void> => {
    const isCurrent = captureTask();
    setCommandLoading(true);
    setCommandError(null);
    try {
      const result = await configureChat({ effort: option.effort });
      if (!isCurrent()) return;
      setChatConfiguration(result);
      setCommandMenuMode(null);
      setDraft('');
    } catch (error) {
      if (!isCurrent()) return;
      setCommandError(errorMessage(error));
    } finally {
      if (isCurrent()) {
        setCommandLoading(false);
        focusComposer();
      }
    }
  };

  const selectPermission = async (mode: ChatPermissionMode): Promise<void> => {
    const isCurrent = captureTask();
    if (!mode.allowed) {
      setCommandError('This permission mode is not allowed by the current Codex policy.');
      return;
    }
    setCommandLoading(true);
    setCommandError(null);
    try {
      await setPermissionMode(mode.id);
      if (!isCurrent()) return;
      setCommandMenuMode(null);
      setDraft('');
    } catch (error) {
      if (!isCurrent()) return;
      setCommandError(errorMessage(error));
    } finally {
      if (isCurrent()) {
        setCommandLoading(false);
        focusComposer();
      }
    }
  };

  const answerApproval = async (decision: ChatApprovalDecision): Promise<void> => {
    const isCurrent = captureTask();
    if (!pendingApproval || approvalLoadingId) return;
    setApprovalLoadingId(pendingApproval.id);
    setApprovalError(null);
    try {
      await respondToApproval(pendingApproval.id, decision);
      if (!isCurrent()) return;
    } catch (error) {
      if (!isCurrent()) return;
      setApprovalError(errorMessage(error));
    } finally {
      if (isCurrent()) {
        setApprovalLoadingId(null);
      }
    }
  };

  const toggleFastMode = async (): Promise<void> => {
    const isCurrent = captureTask();
    setCommandLoading(true);
    setCommandError(null);
    try {
      const catalog = await listModels();
      if (!isCurrent()) return;
      setModels(catalog.models);
      setChatConfiguration(catalog.configuration);
      assertFastModeAvailable(catalog.configuration);
      const result = await configureChat({ fast: !catalog.configuration.fastModeEnabled });
      if (!isCurrent()) return;
      setChatConfiguration(result);
      setCommandMenuMode(null);
      setDraft('');
    } catch (error) {
      if (!isCurrent()) return;
      setCommandError(errorMessage(error));
    } finally {
      if (isCurrent()) {
        setCommandLoading(false);
        focusComposer();
      }
    }
  };

  const commandDisabledReason = (command: SlashCommand): string | null => {
    if (interactionsLocked) return 'Stop the relay before changing this chat.';
    if (command.requiresSession && !state.activeSessionId) return 'Open a chat to use this command';
    if (loading && command.name === 'new') return 'Wait for the current chat to open';
    if (
      (streaming || loading)
      && (
        command.name === 'fork'
        || command.name === 'compact'
        || command.name === 'review'
        || command.name === 'goal'
        || command.name === 'permissions'
      )
    ) return 'Wait for the current response to finish';
    return null;
  };

  const startNewSession = (): void => {
    setDraft('');
    setSelectedSkill(null);
    setAttachments([]);
    setAttachmentError(null);
    setCommandMenuMode(null);
    onNewSession();
  };

  const selectAttachments = async (): Promise<void> => {
    const isCurrent = captureTask();
    if (!cheshiDesktop?.selectCodexChatAttachments || attachmentPickerPending.current || attachmentTransfer.isTransferring()) return;
    attachmentPickerPending.current = true;
    setAttachmentPickerOpen(true);
    setAttachmentError(null);
    try {
      const selected = await cheshiDesktop.selectCodexChatAttachments();
      if (!isCurrent()) return;
      const merged = mergeChatAttachments(attachments, selected);
      setAttachments(merged);
    } catch (error) {
      if (!isCurrent()) return;
      setAttachmentError(errorMessage(error));
    } finally {
      attachmentPickerPending.current = false;
      if (isCurrent()) {
        setAttachmentPickerOpen(false);
        focusComposer();
      }
    }
  };

  const removeAttachment = (attachmentPath: string): void => {
    setAttachments((current) => current.filter(({ path }) => path !== attachmentPath));
  };

  const activateSlashCommand = async (command: SlashCommand): Promise<void> => {
    const disabledReason = commandDisabledReason(command);
    if (disabledReason) {
      setCommandError(disabledReason);
      return;
    }
    if (command.name === 'new') {
      startNewSession();
      return;
    }
    if (command.name === 'agent') {
      await openAgentPicker();
      return;
    }
    if (command.name === 'skills') {
      await openSkillPicker();
      return;
    }
    if (command.name === 'model') {
      await openModelPicker('models');
      return;
    }
    if (command.name === 'reasoning') {
      await openModelPicker('reasoning');
      return;
    }
    if (command.name === 'fast') {
      await toggleFastMode();
      return;
    }
    if (command.name === 'status') {
      await openStatus();
      return;
    }
    if (command.name === 'mcp') {
      await openMcpStatus();
      return;
    }
    if (command.name === 'goal') {
      await openGoalEditor();
      return;
    }
    if (command.name === 'permissions') {
      await openPermissions();
      return;
    }

    setCommandMenuMode(null);
    setDraft('');
    if (command.name === 'fork') await forkSession();
    if (command.name === 'compact') await compactSession();
    if (command.name === 'review') await reviewSession();
  };

  const activateHighlightedOption = (): void => {
    if (agentPickerOpen) {
      const agent = filteredAgents[highlightedIndex];
      if (agent) void selectAgent(agent);
      return;
    }
    if (skillPickerOpen) {
      const skill = filteredSkills[highlightedIndex];
      if (skill) selectSkill(skill);
      return;
    }
    if (modelPickerOpen) {
      const model = filteredModels[highlightedIndex];
      if (model) void selectModel(model);
      return;
    }
    if (reasoningPickerOpen) {
      const option = filteredReasoningEfforts[highlightedIndex];
      if (option) void selectReasoningEffort(option);
      return;
    }
    if (permissionsPickerOpen) {
      const mode = filteredPermissionModes[highlightedIndex];
      if (mode) void selectPermission(mode);
      return;
    }
    if (!slashMenuOpen) return;
    const command = filteredCommands[highlightedIndex];
    if (command) void activateSlashCommand(command);
  };

  const moveHighlightedOption = (offset: number): void => {
    if (visibleOptionCount === 0) return;
    setHighlightedIndex((currentIndex) => (
      (currentIndex + offset + visibleOptionCount) % visibleOptionCount
    ));
  };

  const handleDraftChange = (value: string): void => {
    setDraft(value);
    if (interactionsLocked) return;
    if (configurationMenuOpen) {
      setConfigurationMenuOpen(false);
      setConfigurationMenuView('root');
    }
    if (commandMenuMode && commandMenuMode !== 'commands') return;
    setCommandMenuMode(/^\/\S*$/.test(value) ? 'commands' : null);
  };

  const submit = (event?: SubmitEvent<HTMLFormElement>) => {
    event?.preventDefault();
    if (interactionsLocked || controller.configurationPending) return;
    if (goalEditorOpen) {
      void saveGoal();
      return;
    }
    if (commandMenuOpen) return;
    const value = draft.trim();
    if (!value || loading || sendPending || commandLoading || controller.configurationPending
      || attachmentPickerPending.current || attachmentTransfer.isTransferring()) return;
    stickToBottomRef.current = true;
    scrollingToBottomRef.current = false;
    setShowScrollToBottom(false);
    void submitDraft();
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.nativeEvent.isComposing) return;
    if (interactionsLocked && event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      return;
    }
    if (commandMenuOpen) {
      if (event.key === 'Escape') {
        event.preventDefault();
        closeCommandMenu();
        return;
      }
      if (goalEditorOpen && event.key === 'Enter' && !event.shiftKey) {
        event.preventDefault();
        void saveGoal();
        return;
      }
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        moveHighlightedOption(event.key === 'ArrowDown' ? 1 : -1);
        return;
      }
      if (
        ((event.key === 'Enter' && !event.shiftKey) || event.key === 'Tab')
        && (
          slashMenuOpen
          || agentPickerOpen
          || skillPickerOpen
          || modelPickerOpen
          || reasoningPickerOpen
          || permissionsPickerOpen
        )
      ) {
        event.preventDefault();
        activateHighlightedOption();
        return;
      }
    }
    if (event.key !== 'Enter' || event.shiftKey) return;
    event.preventDefault();
    submit();
  };

  return {
    activateSlashCommand,
    agentPickerOpen,
    answerApproval,
    approvalError,
    approvalLoadingId,
    attachmentError: attachmentError ?? attachmentTransfer.error,
    attachmentTransfer,
    selectCollaborationMode,
    attachmentPickerOpen,
    attachments,
    cancelResponse,
    chatConfiguration,
    closeCommandMenu,
    commandDisabledReason,
    commandError,
    commandLoading,
    commandMenuHelp,
    commandMenuId,
    commandMenuMode,
    commandMenuOpen,
    commandMenuSubtitle,
    commandMenuTitle,
    commandOptionsRef,
    commandStatus,
    composerAreaRef,
    configurationControlsDisabled,
    configurationError,
    configurationLoading,
    configurationMenuId,
    configurationMenuOpen,
    configurationMenuPosition,
    configurationMenuRef,
    configurationMenuView,
    configurationTriggerRef,
    dismissError,
    draft,
    fastTier,
    filteredAgents,
    filteredCommands,
    filteredMcpServers,
    filteredModels,
    filteredPermissionModes,
    filteredReasoningEfforts,
    filteredSkills,
    goal,
    goalEditorOpen,
    handleDraftChange,
    handleKeyDown,
    highlightedIndex,
    interactionsLocked,
    loading,
    mcpServers,
    mcpStatusOpen,
    modelPickerOpen,
    models,
    pauseAutoScroll,
    pendingApproval,
    permissionsPickerOpen,
    reasoningPickerOpen,
    removeAttachment,
    rootRef,
    scrollToBottom,
    scrollToHistoryItem,
    selectAgent,
    selectAttachments,
    selectComposerModel,
    selectComposerReasoningEffort,
    selectComposerServiceTier,
    selectedSkill,
    sendPending,
    sendRecovery,
    restoreFailedMessage,
    canRestoreFailedMessage,
    selectModel,
    selectPermission,
    selectReasoningEffort,
    selectSkill,
    setConfigurationMenuView,
    setHighlightedIndex,
    setSelectedSkill,
    showScrollToBottom,
    skillPickerOpen,
    slashMenuOpen,
    state,
    streaming,
    submit,
    textareaRef,
    timelineRef,
    toggleConfigurationMenu,
    workspaceName,
  };
}

export type ChatViewController = ReturnType<typeof useChatViewController>;

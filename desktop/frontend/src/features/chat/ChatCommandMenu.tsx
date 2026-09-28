import { TooltipTarget } from '../../shared/ui/TooltipTarget';
import { TooltipButton } from '../../shared/ui/TooltipButton';
import {
  Bot,
  Brain,
  Command,
  Server,
  ShieldCheck,
  Sparkles,
  Target,
  Users,
  X,
} from 'lucide-react';

import { LiquidGlassPanel, LoadingState, NeumorphicButton, SidebarPanelHeader } from '../../shared/ui';
import { ChatErrorNotice } from './ChatErrorNotice';
import { formatGoalUsage, formatMcpAuthStatus, formatMcpConnectionStatus, formatMcpServerDetail } from './chatViewModel';
import styles from './ChatView.module.css';
import type { ChatViewController } from './useChatViewController';

export function ChatCommandMenu({ controller }: { controller: ChatViewController }) {
  const {
    activateSlashCommand,
    agentPickerOpen,
    chatConfiguration,
    closeCommandMenu,
    commandDisabledReason,
    commandError,
    commandLoading,
    commandMenuHelp,
    commandMenuMode,
    commandMenuOpen,
    commandMenuSubtitle,
    commandMenuTitle,
    commandOptionsRef,
    commandStatus,
    filteredAgents,
    filteredCommands,
    filteredMcpServers,
    filteredModels,
    filteredPermissionModes,
    filteredReasoningEfforts,
    filteredSkills,
    goal,
    goalEditorOpen,
    highlightedIndex,
    mcpServers,
    mcpStatusOpen,
    modelPickerOpen,
    permissionsPickerOpen,
    reasoningPickerOpen,
    selectAgent,
    selectModel,
    selectPermission,
    selectReasoningEffort,
    selectSkill,
    setHighlightedIndex,
    skillPickerOpen,
    slashMenuOpen,
    state,
  } = controller;

  if (!commandMenuOpen) return null;

  return <div className={styles.commandMenuAnchor}>
    <LiquidGlassPanel
      as="section"
      aria-label={commandMenuTitle}
      className={styles.commandMenu}
      data-liquid-glass-backdrop="true"
      id={controller.commandMenuId}
    >
      <SidebarPanelHeader title={commandMenuTitle.toUpperCase()} actions={
        <TooltipButton variant="ghost" size="icon" aria-label="Close command menu" title="Close command menu"
          onClick={closeCommandMenu}><X aria-hidden="true" /></TooltipButton>
      } />
      <p className={styles.commandMenuSubtitle}>{commandMenuSubtitle}</p>
      <div
        className={styles.commandOptions}
        data-agent-picker={agentPickerOpen ? 'true' : undefined}
        ref={commandOptionsRef}
        role={commandMenuMode === 'status' || mcpStatusOpen || goalEditorOpen ? 'region' : 'listbox'}
      >
        {commandLoading && (
          <LoadingState className={styles.commandEmpty} type="preparing" />
        )}
        {commandError && (
          <ChatErrorNotice className={styles.commandAlert}>{commandError}</ChatErrorNotice>
        )}
        {!commandLoading && agentPickerOpen && (
          <>
            {!commandError && filteredAgents.length === 0 && (
              <div className={styles.commandEmpty}>
                <Users aria-hidden="true" />
                <span>No agent threads in this chat</span>
              </div>
            )}
            {filteredAgents.map((agent, index) => {
              const Icon = agent.kind === 'main' ? Bot : Users;
              return (
                <TooltipButton variant="ghost"
                  aria-selected={index === highlightedIndex}
                  className={styles.commandOption}
                  data-active={index === highlightedIndex ? 'true' : undefined}
                  data-selected={agent.current ? 'true' : undefined}
                  key={agent.id}
                  role="option"
                  style={{ paddingInlineStart: 10 + Math.min(agent.depth, 4) * 12 }}
                  title={agent.id}
                  type="button"
                  onClick={() => void selectAgent(agent)}
                  onMouseEnter={() => setHighlightedIndex(index)}
                >
                  <span className={styles.commandIcon}><Icon aria-hidden="true" /></span>
                  <span className={styles.commandCopy}>
                    <strong>{agent.title}</strong>
                    <span>{agent.description}</span>
                  </span>
                  <span className={styles.commandMeta}>{agent.current ? 'current' : agent.status}</span>
                </TooltipButton>
              );
            })}
          </>
        )}
        {!commandLoading && skillPickerOpen && (
          <>
            {!commandError && filteredSkills.length === 0 && (
              <div className={styles.commandEmpty}>
                <Sparkles aria-hidden="true" />
                <span>No matching skills</span>
              </div>
            )}
            {filteredSkills.map((skill, index) => (
              <TooltipButton variant="ghost"
                aria-selected={index === highlightedIndex}
                className={styles.commandOption}
                data-active={index === highlightedIndex ? 'true' : undefined}
                key={skill.path}
                role="option"
                title={skill.path}
                type="button"
                onClick={() => selectSkill(skill)}
                onMouseEnter={() => setHighlightedIndex(index)}
              >
                <span className={styles.commandIcon}><Sparkles aria-hidden="true" /></span>
                <span className={styles.commandCopy}>
                  <strong>{skill.displayName}</strong>
                  <span>{skill.description || skill.name}</span>
                </span>
                <span className={styles.commandMeta}>{skill.scope}</span>
              </TooltipButton>
            ))}
          </>
        )}
        {!commandLoading && modelPickerOpen && (
          <>
            {!commandError && filteredModels.length === 0 && (
              <div className={styles.commandEmpty}>
                <Bot aria-hidden="true" />
                <span>No available models</span>
              </div>
            )}
            {filteredModels.map((model, index) => (
              <NeumorphicButton variant="ghost"
                aria-selected={index === highlightedIndex}
                className={styles.commandOption}
                data-active={index === highlightedIndex ? 'true' : undefined}
                data-selected={chatConfiguration?.model === model.model ? 'true' : undefined}
                key={model.id}
                role="option"
                type="button"
                onClick={() => void selectModel(model)}
                onMouseEnter={() => setHighlightedIndex(index)}
              >
                <span className={styles.commandIcon}><Bot aria-hidden="true" /></span>
                <span className={styles.commandCopy}>
                  <strong>{model.displayName}</strong>
                  <span>{model.description}</span>
                </span>
                <span className={styles.commandMeta}>
                  {chatConfiguration?.model === model.model ? 'current' : model.isDefault ? 'default' : 'model'}
                </span>
              </NeumorphicButton>
            ))}
          </>
        )}
        {!commandLoading && reasoningPickerOpen && (
          <>
            {!commandError && filteredReasoningEfforts.length === 0 && (
              <div className={styles.commandEmpty}>
                <Brain aria-hidden="true" />
                <span>No reasoning levels for this model</span>
              </div>
            )}
            {filteredReasoningEfforts.map((option, index) => (
              <NeumorphicButton variant="ghost"
                aria-selected={index === highlightedIndex}
                className={styles.commandOption}
                data-active={index === highlightedIndex ? 'true' : undefined}
                data-selected={chatConfiguration?.reasoningEffort === option.effort ? 'true' : undefined}
                key={option.effort}
                role="option"
                type="button"
                onClick={() => void selectReasoningEffort(option)}
                onMouseEnter={() => setHighlightedIndex(index)}
              >
                <span className={styles.commandIcon}><Brain aria-hidden="true" /></span>
                <span className={styles.commandCopy}>
                  <strong>{option.effort}</strong>
                  <span>{option.description}</span>
                </span>
                <span className={styles.commandMeta}>
                  {chatConfiguration?.reasoningEffort === option.effort ? 'current' : 'effort'}
                </span>
              </NeumorphicButton>
            ))}
          </>
        )}
        {!commandLoading && permissionsPickerOpen && (
          <>
            {!commandError && filteredPermissionModes.length === 0 && (
              <div className={styles.commandEmpty}>
                <ShieldCheck aria-hidden="true" />
                <span>No available permission modes</span>
              </div>
            )}
            {filteredPermissionModes.map((mode, index) => (
              <NeumorphicButton variant="ghost"
                aria-disabled={!mode.allowed ? 'true' : undefined}
                aria-selected={index === highlightedIndex}
                className={styles.commandOption}
                data-active={index === highlightedIndex ? 'true' : undefined}
                data-disabled={!mode.allowed ? 'true' : undefined}
                data-selected={state.access === mode.access ? 'true' : undefined}
                key={mode.id}
                role="option"
                type="button"
                onClick={() => void selectPermission(mode)}
                onMouseEnter={() => setHighlightedIndex(index)}
              >
                <span className={styles.commandIcon}><ShieldCheck aria-hidden="true" /></span>
                <span className={styles.commandCopy}>
                  <strong>{mode.label}</strong>
                  <span>{mode.description}</span>
                </span>
                <span className={styles.commandMeta}>
                  {!mode.allowed
                    ? 'unavailable'
                    : state.access === mode.access
                      ? 'current'
                      : mode.dangerous
                        ? 'unrestricted'
                        : mode.access}
                </span>
              </NeumorphicButton>
            ))}
          </>
        )}
        {!commandLoading && commandMenuMode === 'status' && commandStatus && (
          <dl className={styles.commandStatus}>
            <div><dt>Chat ID</dt><TooltipTarget content={commandStatus.threadId ?? undefined}><dd>{commandStatus.threadId ?? 'Not started'}</dd></TooltipTarget></div>
            <div><dt>Model</dt><dd>{commandStatus.modelDisplayName}</dd></div>
            <div><dt>Reasoning</dt><dd>{commandStatus.reasoningEffort}</dd></div>
            <div><dt>Service tier</dt><dd>{commandStatus.serviceTierDisplayName}</dd></div>
            <div><dt>Access</dt><dd>{commandStatus.access}</dd></div>
            <div><dt>Response</dt><dd>{commandStatus.responseInProgress ? 'In progress' : 'Idle'}</dd></div>
          </dl>
        )}
        {!commandLoading && mcpStatusOpen && (
          <>
            {!commandError && filteredMcpServers.length === 0 && (
              <div className={styles.commandEmpty}>
                <Server aria-hidden="true" />
                <span>{mcpServers.length === 0 ? 'No configured MCP servers' : 'No matching MCP servers'}</span>
              </div>
            )}
            {filteredMcpServers.map((server) => (
              <div className={styles.commandOption} data-static="true" key={server.name}>
                <span className={styles.commandIcon}><Server aria-hidden="true" /></span>
                <span className={styles.commandCopy}>
                  <strong>{server.displayName}</strong>
                  <span>{formatMcpServerDetail(server)}</span>
                  {server.toolsError && <TooltipTarget content={server.toolsError}><span role="status">Tool discovery failed: {server.toolsError}</span></TooltipTarget>}
                </span>
                <span className={styles.mcpStatus} data-connected={server.runtimeStatus === 'connected'}>
                  <strong aria-label={`Connection: ${formatMcpConnectionStatus(server)}`}>{formatMcpConnectionStatus(server)}</strong>
                  <TooltipTarget content={server.authStatus === 'unsupported'
                    ? 'MCP sign-in is not supported for this connection. This does not indicate a connection failure.'
                    : undefined}>
                    <span >{formatMcpAuthStatus(server)}</span>
                  </TooltipTarget>
                </span>
              </div>
            ))}
          </>
        )}
        {!commandLoading && goalEditorOpen && !commandError && (
          goal ? (
            <div className={styles.commandOption} data-static="true">
              <span className={styles.commandIcon}><Target aria-hidden="true" /></span>
              <span className={styles.commandCopy}>
                <strong>{goal.objective}</strong>
                <span>{formatGoalUsage(goal)}</span>
              </span>
              <span className={styles.commandMeta}>{goal.status}</span>
            </div>
          ) : (
            <div className={styles.commandEmpty}>
              <Target aria-hidden="true" />
              <span>No persistent goal · type an objective below</span>
            </div>
          )
        )}
        {!commandLoading && slashMenuOpen && (
          <>
            {filteredCommands.length === 0 && (
              <div className={styles.commandEmpty}>
                <Command aria-hidden="true" />
                <span>No matching commands</span>
              </div>
            )}
            {filteredCommands.map((command, index) => {
              const disabledReason = commandDisabledReason(command);
              const Icon = command.icon;
              return (
                <NeumorphicButton variant="ghost"
                  aria-disabled={disabledReason ? 'true' : undefined}
                  aria-selected={index === highlightedIndex}
                  className={styles.commandOption}
                  data-active={index === highlightedIndex ? 'true' : undefined}
                  data-disabled={disabledReason ? 'true' : undefined}
                  key={command.name}
                  role="option"
                  type="button"
                  onClick={() => void activateSlashCommand(command)}
                  onMouseEnter={() => setHighlightedIndex(index)}
                >
                  <span className={styles.commandIcon}><Icon aria-hidden="true" /></span>
                  <span className={styles.commandCopy}>
                    <strong>/{command.name}</strong>
                    <span>{disabledReason ?? command.description}</span>
                  </span>
                  <span className={styles.commandMeta}>{command.meta}</span>
                </NeumorphicButton>
              );
            })}
          </>
        )}
      </div>
      <p className={styles.commandHelp}>{commandMenuHelp}</p>
    </LiquidGlassPanel>
  </div>;
}

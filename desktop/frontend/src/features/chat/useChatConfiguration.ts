import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react';

import { errorMessage } from '../../shared/errorMessage';
import {
  assertFastModeAvailable,
  CONFIGURATION_MENU_WIDTH,
  CONFIGURATION_SUBMENU_WIDTH,
  fastTierForModel,
  type ConfigurationMenuPosition,
  type ConfigurationMenuView,
} from './chatViewModel';
import type { ChatConfiguration, ChatModel, ChatReasoningEffort } from './model';
import type { ChatController } from './useChatController';

interface ChatConfigurationOptions {
  controller: ChatController;
  active: boolean;
  rootRef: RefObject<HTMLElement | null>;
  textareaRef: RefObject<HTMLTextAreaElement | null>;
}

export function useChatConfiguration({ controller, rootRef, textareaRef, active }: ChatConfigurationOptions) {
  const { listModels, configureChat, state, sessionRevision } = controller;
  const sessionKey = `${sessionRevision}:${state.activeSessionId ?? ''}`;
  const [models, setModels] = useState<ChatModel[]>([]);
  const [chatConfiguration, setChatConfiguration] = useState<ChatConfiguration | null>(null);
  const [configurationMenuOpen, setConfigurationMenuOpen] = useState(false);
  const [configurationMenuView, setConfigurationMenuView] = useState<ConfigurationMenuView>('root');
  const [configurationMenuPosition, setConfigurationMenuPosition] = useState<ConfigurationMenuPosition | null>(null);
  const [configurationLoading, setConfigurationLoading] = useState(false);
  const [configurationError, setConfigurationError] = useState<string | null>(null);
  const configurationTriggerRef = useRef<HTMLDivElement>(null);
  const configurationMenuRef = useRef<HTMLDivElement>(null);
  const activeRef = useRef(active);
  activeRef.current = active;
  const requestRef = useRef(0);
  const sessionRef = useRef(sessionKey);
  if (sessionRef.current !== sessionKey) {
    sessionRef.current = sessionKey;
    requestRef.current += 1;
  }
  const activeModel = models.find((model) => model.model === chatConfiguration?.model)
    ?? models.find((model) => model.isDefault);
  const fastTier = fastTierForModel(activeModel);

  const ownsFocus = (target: EventTarget | null): boolean => target instanceof Node && (
    rootRef.current?.contains(target) === true
    || configurationMenuRef.current?.contains(target) === true
  );
  const focusComposer = (): void => {
    const focusedElement = document.activeElement;
    if (!activeRef.current || !ownsFocus(focusedElement)) return;
    requestAnimationFrame(() => {
      if (!activeRef.current) return;
      if (ownsFocus(document.activeElement)
        || (document.activeElement === document.body && !focusedElement?.isConnected)) {
        textareaRef.current?.focus();
      }
    });
  };

  useEffect(() => {
    if (active) return;
    setConfigurationMenuOpen(false);
    setConfigurationMenuView('root');
  }, [active]);

  useEffect(() => {
    const request = ++requestRef.current;
    setChatConfiguration(null);
    setConfigurationLoading(true);
    setConfigurationError(null);
    void listModels()
      .then((catalog) => {
        if (request !== requestRef.current) return;
        setModels(catalog.models);
        setChatConfiguration(catalog.configuration);
      })
      .catch((error: unknown) => {
        if (request === requestRef.current) setConfigurationError(errorMessage(error));
      })
      .finally(() => {
        if (request === requestRef.current) setConfigurationLoading(false);
      });
    return () => { requestRef.current += 1; };
  }, [listModels, sessionKey]);

  useEffect(() => {
    if (!configurationMenuOpen) return undefined;
    const closeMenu = (): void => {
      setConfigurationMenuOpen(false);
      setConfigurationMenuView('root');
    };
    const handlePointerDown = (event: PointerEvent): void => {
      if (!(event.target instanceof Node)) return;
      if (configurationTriggerRef.current?.contains(event.target)
        || configurationMenuRef.current?.contains(event.target)) return;
      closeMenu();
    };
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (!activeRef.current || event.key !== 'Escape' || !ownsFocus(event.target)) return;
      event.preventDefault();
      // Focus before unmounting a portal that currently owns the focused element.
      textareaRef.current?.focus();
      closeMenu();
    };
    document.addEventListener('pointerdown', handlePointerDown);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('pointerdown', handlePointerDown);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [configurationMenuOpen]);

  useLayoutEffect(() => {
    if (!configurationMenuOpen) return undefined;
    const updateMenuPosition = (): void => {
      const trigger = configurationTriggerRef.current;
      if (!trigger) return;
      const rect = trigger.getBoundingClientRect();
      const viewportGap = 8;
      const menuGap = 8;
      const width = Math.min(CONFIGURATION_MENU_WIDTH, window.innerWidth - viewportGap * 2);
      const left = Math.min(window.innerWidth - width - viewportGap, Math.max(viewportGap, rect.right - width));
      const bottom = Math.max(viewportGap, window.innerHeight - rect.top + menuGap);
      const leftSpace = left - viewportGap - menuGap;
      const rightSpace = window.innerWidth - left - width - viewportGap - menuGap;
      const submenuSide = leftSpace >= CONFIGURATION_SUBMENU_WIDTH || leftSpace >= rightSpace ? 'left' : 'right';
      setConfigurationMenuPosition({ bottom, left, submenuSide, width });
    };
    updateMenuPosition();
    const observer = new ResizeObserver(updateMenuPosition);
    if (rootRef.current) observer.observe(rootRef.current);
    if (configurationTriggerRef.current) observer.observe(configurationTriggerRef.current);
    window.addEventListener('resize', updateMenuPosition);
    window.addEventListener('scroll', updateMenuPosition, true);
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', updateMenuPosition);
      window.removeEventListener('scroll', updateMenuPosition, true);
    };
  }, [configurationMenuOpen]);

  const refreshConfiguration = async (): Promise<void> => {
    const request = ++requestRef.current;
    setConfigurationLoading(true);
    setConfigurationError(null);
    try {
      const catalog = await listModels();
      if (request !== requestRef.current) return;
      setModels(catalog.models);
      setChatConfiguration(catalog.configuration);
    } catch (error) {
      if (request === requestRef.current) setConfigurationError(errorMessage(error));
    } finally {
      if (request === requestRef.current) setConfigurationLoading(false);
    }
  };

  const toggleConfigurationMenu = (): void => {
    setConfigurationMenuView('root');
    setConfigurationError(null);
    if (configurationMenuOpen) {
      textareaRef.current?.focus();
      setConfigurationMenuOpen(false);
      return;
    }
    setConfigurationMenuOpen(true);
    if (!chatConfiguration && !configurationLoading) void refreshConfiguration();
  };

  const updateConfiguration = async (input: Parameters<ChatController['configureChat']>[0]): Promise<void> => {
    const request = ++requestRef.current;
    setConfigurationLoading(true);
    setConfigurationError(null);
    try {
      if (input.fast === true && chatConfiguration) assertFastModeAvailable(chatConfiguration);
      const configuration = await configureChat(input);
      if (request !== requestRef.current) return;
      setChatConfiguration(configuration);
      setConfigurationMenuView('root');
    } catch (error) {
      if (request === requestRef.current) setConfigurationError(errorMessage(error));
    } finally {
      if (request === requestRef.current) setConfigurationLoading(false);
    }
  };

  return {
    chatConfiguration, configurationError, configurationLoading,
    configurationMenuOpen, configurationMenuPosition, configurationMenuRef,
    configurationMenuView, configurationTriggerRef, fastTier, models,
    selectComposerModel: (model: ChatModel) => updateConfiguration({ model: model.model }),
    selectComposerReasoningEffort: (option: ChatReasoningEffort) => updateConfiguration({ effort: option.effort }),
    selectComposerServiceTier: (fast: boolean) => updateConfiguration({ fast }),
    setChatConfiguration: (configuration: ChatConfiguration | null) => {
      requestRef.current += 1;
      setConfigurationLoading(false);
      setChatConfiguration(configuration);
    },
    setConfigurationMenuOpen, setConfigurationMenuView,
    setModels, toggleConfigurationMenu, focusComposer,
  };
}

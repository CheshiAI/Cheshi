import { expect, test } from 'bun:test';
import { Children, isValidElement, type ReactElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ChatComposerAttachments } from '../frontend/src/features/chat/ChatComposerAttachments';
import { ChatComposerToolbar } from '../frontend/src/features/chat/ChatComposerToolbar';
import { ChatSubmitButton } from '../frontend/src/features/chat/ChatSubmitButton';
import type { ChatController } from '../frontend/src/features/chat/useChatController';
import type { ChatViewController } from '../frontend/src/features/chat/useChatViewController';

function descendants(node: ReactNode): ReactElement<Record<string, unknown>>[] {
  return Children.toArray(node).flatMap((child) => isValidElement<{ children?: ReactNode }>(child)
    ? [child, ...descendants(child.props.children)] : []);
}

function toolbarHarness() {
  const calls: string[] = [];
  // Only the fields read by the toolbar are supplied at this rendering boundary.
  const controller = {
    draft: 'Keep this draft', streaming: false, goalEditorOpen: false,
    interactionsLocked: false, loading: false, commandLoading: false, commandMenuOpen: false,
    attachmentPickerOpen: false, sendPending: false, configurationControlsDisabled: false, configurationLoading: false,
    attachmentTransfer: { loading: false }, configurationTriggerRef: { current: null },
    configurationMenuOpen: true, configurationMenuId: 'model-menu',
    chatConfiguration: { collaborationMode: 'plan', modelDisplayName: 'Current model', reasoningEffort: 'medium' },
    selectAttachments: () => { calls.push('attach'); },
    selectCollaborationMode: (mode: string) => { calls.push(mode); },
    toggleConfigurationMenu: () => { calls.push('model'); },
    cancelResponse: () => { calls.push('stop'); },
  } as unknown as ChatViewController;
  const chatController = { configurationPending: false } as ChatController;
  const render = () => descendants(ChatComposerToolbar({ controller, chatController }));
  const control = (label: string) => render().find((element) => element.props['aria-label'] === label)!;
  const submit = () => render().find((element) => element.type === ChatSubmitButton)!;
  return { controller, chatController, calls, control, submit };
}

test('extracted toolbar preserves attachment, Plan, and model actions without submitting the draft', () => {
  const app = toolbarHarness();
  for (const label of ['Attach files', 'Plan mode', 'Configure model, reasoning effort, and service tier']) {
    const action = app.control(label);
    expect(action).toBeDefined();
    expect(renderToStaticMarkup(action)).toContain('type="button"');
    const onClick = action.props.onClick;
    if (typeof onClick !== 'function') throw new Error(`Missing action: ${label}`);
    onClick();
  }
  expect(app.calls).toEqual(['attach', 'default', 'model']);
  expect(app.controller.draft).toBe('Keep this draft');
  expect(app.control('Plan mode').props['aria-pressed']).toBe(true);
  expect(app.control('Configure model, reasoning effort, and service tier').props['aria-controls']).toBe('model-menu');
});

test('toolbar blocks sending during configuration and attachment transfers while retaining stop access', () => {
  const app = toolbarHarness();
  expect(app.submit().props.sendDisabled).toBe(false);
  app.chatController.configurationPending = true;
  expect(app.submit().props.sendDisabled).toBe(true);
  app.chatController.configurationPending = false;
  app.controller.attachmentTransfer.loading = true;
  expect(app.submit().props.sendDisabled).toBe(true);
  expect(app.control('Attach files').props.disabled).toBe(true);
  app.controller.streaming = true;
  expect(renderToStaticMarkup(app.submit())).toContain('aria-label="Stop response"');
  const stop = app.submit().props.onStop;
  if (typeof stop !== 'function') throw new Error('Missing stop action');
  stop();
  expect(app.calls).toEqual(['stop']);
});

test('attachment tray preserves previews, fallback file names, and removal by exact path', () => {
  const removed: string[] = [];
  const attachments: ChatViewController['attachments'] = [
    { kind: 'image', name: 'preview.png', path: '/attachments/preview.png', previewUrl: 'data:image/png;base64,AA==' },
    { kind: 'image', name: 'missing.png', path: '/attachments/missing.png' },
    { kind: 'file', name: 'notes.txt', path: '/attachments/notes.txt' },
  ];
  const removeAttachment = (path: string) => { removed.push(path); };
  const tray = ChatComposerAttachments({ attachments, removeAttachment });
  const html = renderToStaticMarkup(tray);
  expect(html.match(/<img\b/g)).toHaveLength(1);
  expect(html).toContain('alt="preview.png"');
  expect(html).toContain('<strong>missing.png</strong>');
  expect(html).toContain('<strong>notes.txt</strong>');
  for (const element of descendants(tray)) {
    if (typeof element.props.onClick === 'function') element.props.onClick();
  }
  expect(removed).toEqual(attachments.map((attachment) => attachment.path));
  expect(ChatComposerAttachments({ attachments: [], removeAttachment })).toBeNull();
});

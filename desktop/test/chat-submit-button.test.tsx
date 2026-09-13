import { expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { ChatSubmitButton } from '../frontend/src/features/chat/ChatSubmitButton';

test('uses one enabled non-submit stop button while a response is running without a sendable instruction', () => {
  let stopped = false;
  const button = ChatSubmitButton({ streaming: true, sendDisabled: true, goalEditorOpen: false,
    onStop: () => { stopped = true; } });
  const html = renderToStaticMarkup(button);
  expect(html.match(/<button\b/g)).toHaveLength(1);
  expect(html).toContain('aria-label="Stop response"');
  expect(html).toContain('type="button"');
  expect(html).not.toContain('disabled=""');
  button.props.onClick();
  expect(stopped).toBe(true);
});

test('uses form submission for additional instructions without cancelling the running response', () => {
  const button = ChatSubmitButton({ streaming: true, sendDisabled: false, goalEditorOpen: false, onStop: () => {} });
  const html = renderToStaticMarkup(button);
  expect(html.match(/<button\b/g)).toHaveLength(1);
  expect(html).toContain('aria-label="Send additional instruction"');
  expect(html).toContain('type="submit"');
  expect(button.props.onClick).toBeUndefined();
});

test('returns to a disabled send button when idle and preserves goal submission', () => {
  const idle = renderToStaticMarkup(<ChatSubmitButton streaming={false} sendDisabled goalEditorOpen={false} onStop={() => {}} />);
  expect(idle).toContain('aria-label="Send message"');
  expect(idle).toContain('disabled=""');
  const goal = renderToStaticMarkup(<ChatSubmitButton streaming={false} sendDisabled={false} goalEditorOpen onStop={() => {}} />);
  expect(goal).toContain('aria-label="Set persistent goal"');
  expect(goal).toContain('type="submit"');
});

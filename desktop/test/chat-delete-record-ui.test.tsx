import { expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { ChatDeleteRecordForm } from '../frontend/src/features/chat/ChatDeleteRecordDialog';

test('record deletion explains the scope and keeps original conversations intact', () => {
  for (const kind of ['history', 'turn'] as const) {
    const html = renderToStaticMarkup(<ChatDeleteRecordForm recordTitle="Saved discussion" kind={kind}
      pending={false} error="Storage failed." onDelete={() => {}} onClose={() => {}} />);
    expect(html).toContain('title="Saved discussion"');
    expect(html).toContain('Your original chat sessions are unaffected. This cannot be undone.');
    expect(html).toContain('role="alert">Storage failed.');
    expect(html).toContain('autofocus=""');
    expect(html).toContain(kind === 'history' ? 'Delete history' : 'Delete saved turn');
    expect(html).not.toContain('aria-label="Deleting saved record…"');
  }
});

test('pending deletion blocks Enter submissions and exposes progress', () => {
  let calls = 0;
  const props = { recordTitle: 'Saved discussion', kind: 'turn' as const, pending: true, error: null,
    onDelete: () => { calls += 1; }, onClose: () => {} };
  const view = ChatDeleteRecordForm(props);
  view.props.onSubmit({ preventDefault() {} });
  expect(calls).toBe(0);
  const html = renderToStaticMarkup(view);
  expect(html).toContain('role="status" aria-label="Deleting saved record…"');
  expect(html).toContain('0.0s');
  expect(html).toContain('aria-busy="true"');
  expect(html.match(/disabled=""/g)).toHaveLength(2);
  ChatDeleteRecordForm({ ...props, pending: false }).props.onSubmit({ preventDefault() {} });
  expect(calls).toBe(1);
});

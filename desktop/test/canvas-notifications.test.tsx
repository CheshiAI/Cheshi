import { expect, test } from 'bun:test';
import { canvasErrorNotification } from '../frontend/src/features/canvas/integration/sdk/canvasNotifications';
import { isStatusToastMessage } from '../shared/status-toast';

test('missing design errors name the requested file without the Electron transport or absolute path', () => {
  const error = new Error("Error invoking remote method 'cheshi:canvas:read': Error: ENOENT: no such file or directory, lstat '/Users/test/project/design-tests/example.fig'");
  const message = canvasErrorNotification(error, 'open', 'ko', 'design-tests/example.fig');
  expect(message).toEqual({ variant: 'error', title: '디자인 파일을 열 수 없습니다', description: 'design-tests/example.fig 파일을 찾을 수 없습니다.' });
  expect(isStatusToastMessage({ ...message, id: 1 })).toBe(true);
});

test('native ENOENT codes and English messages are supported', () => {
  const error = Object.assign(new Error('missing'), { code: 'ENOENT' });
  expect(canvasErrorNotification(error, 'open', 'en', 'design.fig').description).toBe('File not found: design.fig');
});

test('save failures retain their operation instead of claiming an existing design was not found', () => {
  const message = canvasErrorNotification(new Error('ENOENT: target directory is missing'), 'save', 'en', 'new.fig');
  expect(message.title).toBe('Could not save the design file');
  expect(message.description).toBe('ENOENT: target directory is missing');
});

test('permission errors offer a useful explanation', () => {
  for (const code of ['EACCES', 'EPERM']) {
    const message = canvasErrorNotification(new Error(`Error invoking remote method 'cheshi:canvas:save': Error: ${code}: access denied`), 'save', 'en');
    expect(message.description).toBe('Check the file permissions and try again.');
  }
});

test('unrecognized failures preserve their explanation and empty failures have a fallback', () => {
  expect(canvasErrorNotification(new Error("Error invoking remote method 'cheshi:canvas:read': Error: Invalid design archive."), 'open', 'en').description).toBe('Invalid design archive.');
  expect(canvasErrorNotification(null, 'edit', 'ko').description).toBe('다시 시도해 주세요.');
  expect(canvasErrorNotification('Could not decode the file.', 'open', 'en').description).toBe('Could not decode the file.');
});

test('remember failures explain that the design remains available', () => {
  const message = canvasErrorNotification(new Error('Disk full'), 'remember', 'en');
  expect(message.variant).toBe('warning');
  expect(message.description).toBe('The design is available, but it may not reopen automatically. Disk full');
});

test('missing file bridge gives a restart instruction and long errors satisfy the toast boundary', () => {
  expect(canvasErrorNotification(null, 'unavailable', 'ko').description).toBe('로컬 파일을 사용하려면 Cheshi를 다시 시작해 주세요.');
  const message = { ...canvasErrorNotification('x'.repeat(5000), 'edit', 'en'), id: 2 };
  expect(message.description.length).toBe(4096);
  expect(isStatusToastMessage(message)).toBe(true);
});

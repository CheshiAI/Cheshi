import { describe, expect, test } from 'bun:test';

import { chatCommandMenuSubtitle, formatMcpAuthStatus, formatMcpConnectionStatus, formatMcpServerDetail } from '../frontend/src/features/chat/chatViewModel';
import { normalizeMcpServersResponse } from '../frontend/src/features/chat/model';

const counts = { agents: 0, skills: 0, models: 0, reasoning: 0, mcp: 0, permissions: 0 };

describe('MCP command menu status', () => {
  test('does not present an unsuccessful status query as an empty configuration', () => {
    const subtitle = chatCommandMenuSubtitle('mcp', false, counts, null, 'thread not found');
    expect(subtitle).toBe('MCP status unavailable');
    expect(subtitle).not.toContain('0 configured');
  });

  test('distinguishes loading from a successfully loaded empty configuration', () => {
    expect(chatCommandMenuSubtitle('mcp', true, counts, null)).toBe('Loading from Codex');
    expect(chatCommandMenuSubtitle('mcp', false, counts, null)).toBe('0 configured');
  });

  test('shows the configured count when a subsequent query succeeds', () => {
    expect(chatCommandMenuSubtitle('mcp', false, { ...counts, mcp: 2 }, null)).toBe('2 configured');
  });
});

const mcpServer = {
  name: 'computer-use', displayName: 'computer-use', version: null,
  toolCount: 0, resourceCount: 0, resourceTemplateCount: 0,
  connected: false, authStatus: 'unsupported',
};

describe('MCP connection and authentication presentation', () => {
  test.each([
    [0, 0, 0, '0 tools · 0 resources'],
    [1, 1, 0, '1 tool · 1 resource'],
    [2, 0, 1, '2 tools · 1 resource'],
    [1, 1, 1, '1 tool · 2 resources'],
  ])('formats tool and combined resource counts: %s, %s, %s', (toolCount, resourceCount, resourceTemplateCount, expected) => {
    const [server] = normalizeMcpServersResponse({ servers: [{
      ...mcpServer, runtimeStatus: 'connected', version: '1.5.0', toolCount, resourceCount, resourceTemplateCount,
    }] });
    expect(formatMcpServerDetail(server!)).toBe(`computer-use · v1.5.0 · ${expected}`);
  });

  test('does not turn unsupported authentication and zero tools into a connection failure', () => {
    const [server] = normalizeMcpServersResponse({ servers: [{ ...mcpServer, runtimeStatus: 'notStarted' }] });
    expect(formatMcpConnectionStatus(server!)).toBe('Not started');
    expect(formatMcpAuthStatus(server!)).toBe('Auth: not applicable');
  });

  test('uses explicit connection state even when cached metadata indicates a connection', () => {
    const [server] = normalizeMcpServersResponse({ servers: [{
      ...mcpServer, connected: true, runtimeStatus: 'failed', toolsError: 'Executable not found',
    }] });
    expect(server?.connected).toBe(false);
    expect(server?.toolsError).toBe('Executable not found');
    expect(formatMcpConnectionStatus(server!)).toBe('Failed');
    expect(formatMcpAuthStatus(server!)).toBe('Auth: not applicable');
  });

  test.each([null, 'future-status', 1, true])('keeps unavailable or malformed connection state unknown: %s', (runtimeStatus) => {
    const [server] = normalizeMcpServersResponse({ servers: [{ ...mcpServer, connected: true, runtimeStatus }] });
    expect(server?.runtimeStatus).toBeNull();
    expect(formatMcpConnectionStatus(server!)).toBe('Status unknown');
  });

  test('can show connected independently from unsupported authentication', () => {
    const [server] = normalizeMcpServersResponse({ servers: [{ ...mcpServer, runtimeStatus: 'connected' }] });
    expect(formatMcpConnectionStatus(server!)).toBe('Connected');
    expect(formatMcpAuthStatus(server!)).toBe('Auth: not applicable');
  });

  test('retains legacy connection evidence only when the runtime field is absent', () => {
    const [server] = normalizeMcpServersResponse({ servers: [{ ...mcpServer, connected: true }] });
    expect(formatMcpConnectionStatus(server!)).toBe('Connected');
    const [unknown] = normalizeMcpServersResponse({ servers: [mcpServer] });
    expect(formatMcpConnectionStatus(unknown!)).toBe('Status unknown');
  });
});

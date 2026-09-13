import { buildTomlTable, removeTomlTable, upsertTomlTable } from '../src/installer/targets/toml';
import { describe, expect, it } from 'bun:test';

export function registerInstallerTargetsTomlSerializerCodexBackboneTests(): void {


  describe('Installer targets — TOML serializer (Codex backbone)', () => {
    it('builds a [mcp_servers.codegraph] block with command + args', () => {
      const block = buildTomlTable('mcp_servers.codegraph', {
        command: 'codegraph',
        args: ['serve', '--mcp'],
      });
      expect(block).toContain('[mcp_servers.codegraph]');
      expect(block).toContain('command = "codegraph"');
      expect(block).toContain('args = ["serve", "--mcp"]');
    });

    it('serializes environment maps as an inline table in the managed block', () => {
      const block = buildTomlTable('mcp_servers.codegraph', {
        command: 'codegraph',
        env: { CODEGRAPH_DATA_ROOT: '/tmp/cheshi data' },
      });
      expect(block).toContain('env = { CODEGRAPH_DATA_ROOT = "/tmp/cheshi data" }');
    });

    it('upsert inserts into empty content', () => {
      const block = buildTomlTable('mcp_servers.codegraph', { command: 'codegraph', args: ['serve'] });
      const { content, action } = upsertTomlTable('', 'mcp_servers.codegraph', block);
      expect(action).toBe('inserted');
      expect(content.startsWith('[mcp_servers.codegraph]')).toBe(true);
    });

    it('upsert is idempotent — second call returns unchanged', () => {
      const block = buildTomlTable('mcp_servers.codegraph', { command: 'codegraph', args: ['serve'] });
      const first = upsertTomlTable('', 'mcp_servers.codegraph', block);
      const second = upsertTomlTable(first.content, 'mcp_servers.codegraph', block);
      expect(second.action).toBe('unchanged');
      expect(second.content).toBe(first.content);
    });

    it('upsert replaces an existing block in place, preserving sibling tables', () => {
      const existing = [
        '[other_table]',
        'foo = "bar"',
        '',
        '[mcp_servers.codegraph]',
        'command = "old-codegraph"',
        'args = ["old"]',
        '',
        '[zzz]',
        'baz = "qux"',
        '',
      ].join('\n');
      const newBlock = buildTomlTable('mcp_servers.codegraph', {
        command: 'codegraph',
        args: ['serve', '--mcp'],
      });
      const { content, action } = upsertTomlTable(existing, 'mcp_servers.codegraph', newBlock);
      expect(action).toBe('replaced');
      expect(content).toContain('[other_table]');
      expect(content).toContain('foo = "bar"');
      expect(content).toContain('[zzz]');
      expect(content).toContain('baz = "qux"');
      expect(content).toContain('command = "codegraph"');
      expect(content).not.toContain('old-codegraph');
    });

    it('removeTomlTable strips the block and preserves siblings', () => {
      const existing = [
        '[other_table]',
        'foo = "bar"',
        '',
        '[mcp_servers.codegraph]',
        'command = "codegraph"',
        'args = ["serve"]',
      ].join('\n');
      const { content, action } = removeTomlTable(existing, 'mcp_servers.codegraph');
      expect(action).toBe('removed');
      expect(content).toContain('[other_table]');
      expect(content).toContain('foo = "bar"');
      expect(content).not.toContain('mcp_servers.codegraph');
    });

    it('removeTomlTable on missing table returns not-found, no content change', () => {
      const existing = '[other]\nfoo = "bar"\n';
      const { content, action } = removeTomlTable(existing, 'mcp_servers.codegraph');
      expect(action).toBe('not-found');
      expect(content).toBe(existing);
    });

    it('upsert preserves an array-of-tables sibling [[foo]]', () => {
      const existing = [
        '[[foo]]',
        'name = "a"',
        '',
        '[[foo]]',
        'name = "b"',
        '',
      ].join('\n');
      const block = buildTomlTable('mcp_servers.codegraph', { command: 'codegraph', args: ['serve'] });
      const { content } = upsertTomlTable(existing, 'mcp_servers.codegraph', block);
      expect(content.match(/\[\[foo]]/g)?.length).toBe(2);
      expect(content).toContain('[mcp_servers.codegraph]');
    });

    it('upsert replaces the managed table without consuming trailing array-of-tables siblings', () => {
      const historyTables = [
        '[[history]]',
        'id = 1',
        'note = "keep first"',
        '',
        '[[history]]',
        'id = 2',
        'note = "keep second"',
        '',
      ].join('\n');
      const existing = [
        '[mcp_servers.codegraph]',
        'command = "old-codegraph"',
        'args = ["old"]',
        '',
        historyTables,
      ].join('\n');
      const block = buildTomlTable('mcp_servers.codegraph', {
        command: 'codegraph',
        args: ['serve', '--mcp'],
      });

      const { content, action } = upsertTomlTable(existing, 'mcp_servers.codegraph', block);

      expect(action).toBe('replaced');
      expect(content).toBe(`${block}\n\n${historyTables}`);
    });

    it('remove preserves trailing array-of-tables siblings byte-for-byte', () => {
      const historyTables = [
        '[[history]]',
        'id = 1',
        'note = "keep first"',
        '',
        '[[history]]',
        'id = 2',
        'note = "keep second"',
        '',
      ].join('\n');
      const existing = [
        '[mcp_servers.codegraph]',
        'command = "codegraph"',
        'args = ["serve", "--mcp"]',
        '',
        historyTables,
      ].join('\n');

      const { content, action } = removeTomlTable(existing, 'mcp_servers.codegraph');

      expect(action).toBe('removed');
      expect(content).toBe(historyTables);
    });

    it.each([
      ['table', '[ mcp_servers.other ]'],
      ['array-of-tables', '[[ history ]]'],
    ])('preserves a trailing %s header with inner whitespace', (_kind, siblingHeader) => {
      const siblingTable = `${siblingHeader}\nvalue = "keep"\n`;
      const existing = [
        '[mcp_servers.codegraph]',
        'command = "old-codegraph"',
        'args = ["old"]',
        '',
        siblingTable,
      ].join('\n');
      const block = buildTomlTable('mcp_servers.codegraph', {
        command: 'codegraph',
        args: ['serve', '--mcp'],
      });

      const upserted = upsertTomlTable(existing, 'mcp_servers.codegraph', block);
      const removed = removeTomlTable(existing, 'mcp_servers.codegraph');

      expect(upserted.content).toBe(`${block}\n\n${siblingTable}`);
      expect(removed.content).toBe(siblingTable);
    });

    it.each([
      ['basic', '"""'],
      ['literal', "'''"],
    ])('ignores header-shaped text inside a multiline %s string', (_kind, delimiter) => {
      const historyTable = '[[history]]\nid = 1\n';
      const existing = [
        '[mcp_servers.codegraph]',
        'command = "old-codegraph"',
        'args = [',
        `  ${delimiter}first line`,
        '[[not-a-table]]',
        `last line${delimiter},`,
        '  "serve",',
        ']',
        '',
        historyTable,
      ].join('\n');
      const block = buildTomlTable('mcp_servers.codegraph', {
        command: 'codegraph',
        args: ['serve', '--mcp'],
      });

      const upserted = upsertTomlTable(existing, 'mcp_servers.codegraph', block);
      const removed = removeTomlTable(existing, 'mcp_servers.codegraph');

      expect(upserted.content).toBe(`${block}\n\n${historyTable}`);
      expect(removed.content).toBe(historyTable);
    });
  });
}

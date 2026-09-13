let input = Buffer.alloc(0);
const renameWithoutPrepare = process.argv.includes('--rename-without-prepare');

function send(value) {
  const payload = JSON.stringify({ jsonrpc: '2.0', ...value });
  process.stdout.write(`Content-Length: ${Buffer.byteLength(payload, 'utf8')}\r\n\r\n${payload}`);
}

function handleMessage(message) {
  if (message.method === 'initialize') {
    send({
      id: message.id,
      result: {
        capabilities: {
          codeActionProvider: { resolveProvider: true },
          completionProvider: { triggerCharacters: ['.'] },
          definitionProvider: true,
          hoverProvider: true,
          referencesProvider: true,
          renameProvider: renameWithoutPrepare ? true : { prepareProvider: true },
          signatureHelpProvider: { triggerCharacters: ['(', ','] },
          textDocumentSync: 1,
        },
      },
    });
    return;
  }
  if (message.method === 'shutdown') {
    send({ id: message.id, result: null });
    return;
  }
  if (message.method === 'exit') {
    process.exit(0);
  }
  if (message.method === 'textDocument/completion') {
    const character = message.params.position.character;
    send({
      id: message.id,
      result: {
        isIncomplete: false,
        items: [{
          label: 'fakeCompletion',
          kind: 3,
          detail: 'Fake completion detail',
          documentation: { kind: 'markdown', value: 'Fake completion documentation.' },
          textEdit: {
            range: {
              start: { line: message.params.position.line, character: Math.max(0, character - 2) },
              end: message.params.position,
            },
            newText: 'completedValue',
          },
          tags: [1],
          commitCharacters: ['.'],
        }],
      },
    });
    return;
  }
  if (message.method === 'textDocument/hover') {
    send({
      id: message.id,
      result: {
        contents: [
          { language: 'rust', value: 'fn fake_completion() -> i32' },
          { kind: 'markdown', value: 'Fake hover documentation.' },
        ],
        range: {
          start: { line: message.params.position.line, character: 12 },
          end: { line: message.params.position.line, character: 26 },
        },
      },
    });
    return;
  }
  if (message.method === 'textDocument/definition') {
    send({
      id: message.id,
      result: {
        uri: message.params.textDocument.uri,
        range: { start: { line: 0, character: 3 }, end: { line: 0, character: 7 } },
      },
    });
    return;
  }
  if (message.method === 'textDocument/references') {
    send({
      id: message.id,
      result: [
        {
          uri: message.params.textDocument.uri,
          range: { start: { line: 0, character: 3 }, end: { line: 0, character: 7 } },
        },
        {
          uri: message.params.textDocument.uri,
          range: { start: { line: 0, character: 12 }, end: { line: 0, character: 26 } },
        },
      ],
    });
    return;
  }
  if (message.method === 'textDocument/signatureHelp') {
    send({
      id: message.id,
      result: {
        signatures: [{
          label: 'fakeCompletion(value: string, count: number): number',
          documentation: { kind: 'markdown', value: 'Fake signature documentation.' },
          parameters: [
            { label: 'value: string', documentation: 'The value.' },
            { label: [30, 43], documentation: 'The count.' },
          ],
        }],
        activeSignature: 0,
        activeParameter: 1,
      },
    });
    return;
  }
  if (message.method === 'textDocument/prepareRename') {
    const character = message.params.position.character;
    send({
      id: message.id,
      result: renameWithoutPrepare || character === 0
        ? null
        : character === 1
          ? { defaultBehavior: true }
          : {
              range: { start: { line: 0, character: 12 }, end: { line: 0, character: 26 } },
              placeholder: 'fakeCompletion',
            },
    });
    return;
  }
  if (message.method === 'textDocument/rename') {
    const targetUri = message.params.newName === 'outsideWorkspace'
      ? 'file:///tmp/cheshi-outside.ts'
      : message.params.textDocument.uri;
    send({
      id: message.id,
      result: {
        changes: {
          [targetUri]: [{
            range: { start: { line: 0, character: 12 }, end: { line: 0, character: 26 } },
            newText: message.params.newName,
          }],
        },
      },
    });
    return;
  }
  if (message.method === 'textDocument/codeAction') {
    send({
      id: message.id,
      result: [
        {
          title: 'Apply fake quick fix',
          kind: 'quickfix',
          isPreferred: true,
          data: { uri: message.params.textDocument.uri },
        },
        {
          title: 'Apply incomplete fake refactor',
          kind: 'refactor',
          edit: {
            changes: {
              [message.params.textDocument.uri]: [{
                range: { start: { line: 0, character: 0 }, end: { line: 0, character: 5 } },
                newText: 'partial',
              }],
            },
          },
          command: { title: 'Complete fake refactor', command: 'fake.completeRefactor' },
        },
      ],
    });
    return;
  }
  if (message.method === 'codeAction/resolve') {
    send({
      id: message.id,
      result: {
        ...message.params,
        edit: {
          changes: {
            [message.params.data.uri]: [{
              range: { start: { line: 0, character: 0 }, end: { line: 0, character: 5 } },
              newText: 'fixed',
            }],
          },
        },
        command: {
          title: '',
          command: '_typescript.applyCodeActionCommand',
          arguments: [{ action: { commands: [] } }],
        },
      },
    });
    return;
  }
  if (message.method !== 'textDocument/didOpen' && message.method !== 'textDocument/didChange') return;
  const textDocument = message.method === 'textDocument/didOpen'
    ? message.params.textDocument
    : message.params.textDocument;
  send({
    method: 'textDocument/publishDiagnostics',
    params: {
      uri: textDocument.uri,
      version: textDocument.version,
      diagnostics: [{
        range: { start: { line: 0, character: 0 }, end: { line: 0, character: 5 } },
        severity: 1,
        code: 'fake-error',
        source: 'fake-lsp',
        tags: [2],
        message: `fake diagnostic from ${process.cwd()}`,
      }],
    },
  });
}

function parseInput() {
  while (input.length > 0) {
    const headerEnd = input.indexOf('\r\n\r\n');
    if (headerEnd < 0) return;
    const header = input.subarray(0, headerEnd).toString('ascii');
    const match = /^content-length:\s*(\d+)\s*$/im.exec(header);
    if (!match) process.exit(2);
    const length = Number(match[1]);
    const bodyStart = headerEnd + 4;
    const bodyEnd = bodyStart + length;
    if (input.length < bodyEnd) return;
    const body = input.subarray(bodyStart, bodyEnd).toString('utf8');
    input = input.subarray(bodyEnd);
    handleMessage(JSON.parse(body));
  }
}

process.stdin.on('data', (chunk) => {
  input = Buffer.concat([input, Buffer.from(chunk)]);
  parseInput();
});

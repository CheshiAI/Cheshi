import { readFile, truncate } from 'node:fs/promises';

interface FileRange { offset: number; size: number }

function requireLayout(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`Cannot normalize Bun Mach-O: ${message}`);
}

function boundedRange(offset: number, size: number, end: number): boolean {
  return Number.isSafeInteger(offset) && Number.isSafeInteger(size)
    && offset >= 0 && size >= 0 && offset <= end && size <= end - offset;
}

function signatureBoundary(bytes: Buffer): number {
  requireLayout(bytes.length >= 32 && bytes.readUInt32LE(0) === 0xfeedfacf,
    'expected a thin little-endian 64-bit executable');
  requireLayout(bytes.readUInt32LE(12) === 2, 'expected MH_EXECUTE');
  const commandCount = bytes.readUInt32LE(16);
  const commandsEnd = 32 + bytes.readUInt32LE(20);
  requireLayout(commandsEnd <= bytes.length && commandCount <= (commandsEnd - 32) / 8,
    'invalid load-command bounds');
  const ranges: FileRange[] = [];
  let signature: FileRange | undefined;
  let linkedit: FileRange | undefined;
  let bunCount = 0;
  let unknownCommand = false;
  let cursor = 32;

  for (let index = 0; index < commandCount; index += 1) {
    requireLayout(cursor + 8 <= commandsEnd, 'truncated load command');
    const command = bytes.readUInt32LE(cursor);
    const size = bytes.readUInt32LE(cursor + 4);
    requireLayout(size >= 8 && size % 8 === 0 && cursor + size <= commandsEnd,
      'invalid load-command size');
    const requireSize = (minimum: number) => requireLayout(size >= minimum, 'short load command');
    const uint64 = (offset: number) => {
      const value = bytes.readBigUInt64LE(cursor + offset);
      requireLayout(value <= BigInt(Number.MAX_SAFE_INTEGER), 'oversized file offset');
      return Number(value);
    };
    const addRange = (offset: number, length: number) => ranges.push({ offset, size: length });
    const addTable = (offsetField: number, countField: number, entrySize: number) => {
      addRange(bytes.readUInt32LE(cursor + offsetField), bytes.readUInt32LE(cursor + countField) * entrySize);
    };

    if (command === 0x19) { // LC_SEGMENT_64 and its section records.
      requireSize(72);
      const name = bytes.toString('ascii', cursor + 8, cursor + 24).split('\0')[0];
      const segment = { offset: uint64(40), size: uint64(48) };
      const sections = bytes.readUInt32LE(cursor + 64);
      requireLayout(size === 72 + sections * 80, 'invalid section table');
      if (name === '__LINKEDIT') {
        requireLayout(!linkedit, 'duplicate __LINKEDIT segment');
        linkedit = segment;
      } else {
        addRange(segment.offset, segment.size);
      }
      if (name === '__BUN') bunCount += 1;
      for (let section = 0; section < sections; section += 1) {
        const start = 72 + section * 80;
        const type = bytes.readUInt32LE(cursor + start + 64) & 0xff;
        const offset = bytes.readUInt32LE(cursor + start + 48);
        const length = uint64(start + 40);
        if (![1, 0xc, 0x12].includes(type)) { // Zero-fill sections occupy no file bytes.
          requireLayout(offset >= segment.offset
            && boundedRange(offset - segment.offset, length, segment.size), 'section outside its segment');
          addRange(offset, length);
        }
        addTable(start + 56, start + 60, 8);
      }
    } else if (command === 0x1d) {
      requireLayout(size === 16 && !signature, 'invalid or duplicate code signature');
      signature = { offset: bytes.readUInt32LE(cursor + 8), size: bytes.readUInt32LE(cursor + 12) };
    } else if ([0x1e, 0x26, 0x29, 0x2b, 0x2e, 0x80000033, 0x80000034, 0x36].includes(command)) {
      requireLayout(size === 16, 'invalid linkedit data command');
      addTable(8, 12, 1);
    } else if (command === 2) { // LC_SYMTAB
      requireLayout(size === 24, 'invalid symbol table command');
      addTable(8, 12, 16);
      addTable(16, 20, 1);
    } else if (command === 0xb) { // LC_DYSYMTAB
      requireLayout(size === 80, 'invalid dynamic symbol table command');
      for (const [offset, count, stride] of [[32, 36, 8], [40, 44, 56], [48, 52, 4],
        [56, 60, 4], [64, 68, 8], [72, 76, 8]]) addTable(offset!, count!, stride!);
    } else if (command === 0x22 || command === 0x80000022) {
      requireLayout(size === 48, 'invalid dyld info command');
      for (let field = 8; field < 48; field += 8) addTable(field, field + 4, 1);
    } else if (command === 0x80000028) { // LC_MAIN entry offset.
      requireLayout(size === 24, 'invalid entry-point command');
      addRange(uint64(8), 1);
    } else if ([0xc, 0xd, 0xe, 0xf, 0x80000018, 0x8000001c, 0x8000001f,
      0x20, 0x80000023, 0x24, 0x25, 0x27, 0x2a, 0x2f, 0x30, 0x32, 0x1b].includes(command)) {
      // These commands contain metadata or inline names, never external file ranges.
    } else {
      unknownCommand = true;
    }
    cursor += size;
  }

  requireLayout(cursor === commandsEnd, 'load-command size mismatch');
  requireLayout(bunCount === 1 && signature && linkedit, 'missing Bun segment or signature layout');
  requireLayout(signature.size >= 12 && boundedRange(signature.offset, signature.size, bytes.length),
    'code signature outside file');
  const end = signature.offset + signature.size;
  requireLayout(linkedit.offset >= commandsEnd && boundedRange(linkedit.offset, linkedit.size, end)
    && linkedit.offset + linkedit.size === end && signature.offset >= linkedit.offset,
  'signature must finish the final __LINKEDIT segment');
  requireLayout(ranges.every(range => boundedRange(range.offset, range.size, signature.offset)),
    'file-backed data overlaps or extends beyond the signature');
  requireLayout(bytes.readUInt32BE(signature.offset) === 0xfade0cc0
    && bytes.readUInt32BE(signature.offset + 4) === signature.size, 'invalid signature superblob');
  const blobs = bytes.readUInt32BE(signature.offset + 8);
  requireLayout(blobs > 0 && blobs <= (signature.size - 12) / 8, 'invalid signature index');
  for (let index = 0; index < blobs; index += 1) {
    const offset = bytes.readUInt32BE(signature.offset + 16 + index * 8);
    requireLayout(offset >= 12 + blobs * 8 && boundedRange(offset, 8, signature.size), 'invalid signature blob offset');
    const length = bytes.readUInt32BE(signature.offset + offset + 4);
    requireLayout(length >= 8 && boundedRange(offset, length, signature.size), 'invalid signature blob length');
  }
  requireLayout(end === bytes.length || !unknownCommand, 'unsupported load command with trailing bytes');
  return end;
}

/**
 * Use only immediately after `bun build --compile`, before distribution signing.
 * Bun can leave bytes from its template's larger signature past __LINKEDIT:
 * https://github.com/oven-sh/bun/pull/32162
 * Those stale bytes need not be zero. Never apply this to arbitrary/signed inputs.
 */
export async function normalizeBunMachO(filePath: string): Promise<number> {
  const bytes = await readFile(filePath);
  const end = signatureBoundary(bytes);
  const removedBytes = bytes.length - end;
  if (removedBytes > 0) await truncate(filePath, end);
  return removedBytes;
}

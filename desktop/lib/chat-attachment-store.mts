import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { copyFile, mkdir, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { validatedChatAttachmentTransfers } from './chat-attachment-transfer.mts';

const IMAGE_ATTACHMENT_EXTENSIONS = new Set([
  ".bmp",
  ".gif",
  ".jpeg",
  ".jpg",
  ".png",
  ".tif",
  ".tiff",
  ".webp",
]);
const SAFE_EXTENSION = /^\.[a-z0-9]{1,16}$/;

/**
 * @param {unknown} value
 * @param {string} label
 * @returns {string}
 */
function absolutePath(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new TypeError(`${label} must be a non-empty string.`);
  }
  const normalized = path.resolve(value.trim());
  if (!path.isAbsolute(value.trim()))
    throw new TypeError(`${label} must be absolute.`);
  return normalized;
}

/**
 * @param {string} filePath
 * @returns {'image' | 'file'}
 */
export function chatAttachmentKind(filePath: string): "image" | "file" {
  return IMAGE_ATTACHMENT_EXTENSIONS.has(
    path.extname(filePath).toLocaleLowerCase(),
  )
    ? "image"
    : "file";
}

/**
 * @param {string} filePath
 * @returns {string}
 */
function storedExtension(filePath: string): string {
  const extension = path.extname(filePath).toLocaleLowerCase();
  return SAFE_EXTENSION.test(extension) ? extension : "";
}

/**
 * @param {string} filePath
 * @returns {Promise<string>}
 */
async function sha256(filePath: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(filePath)) hash.update(chunk);
  return hash.digest("hex");
}

/**
 * @param {string} filePath
 * @returns {Promise<import('node:fs').Stats>}
 */
async function regularFileStats(
  filePath: string,
): Promise<import("node:fs").Stats> {
  const details = await stat(filePath);
  if (!details.isFile())
    throw new TypeError("Chat attachments must be regular files.");
  return details;
}

/**
 * @param {string} filePath
 * @param {string} expectedHash
 * @param {number} expectedSize
 * @returns {Promise<boolean>}
 */
async function matchesStoredFile(
  filePath: string,
  expectedHash: string,
  expectedSize: number,
): Promise<boolean> {
  try {
    const details = await regularFileStats(filePath);
    return (
      details.size === expectedSize && (await sha256(filePath)) === expectedHash
    );
  } catch (error) {
    if (
      error &&
      typeof error === "object" &&
      "code" in error &&
      error.code === "ENOENT"
    )
      return false;
    throw error;
  }
}

export class ChatAttachmentStore {
  objectsDirectory: string;
  /** @param {{ directory: string }} options */
  constructor({ directory }: { directory: string }) {
    const rootDirectory = absolutePath(
      directory,
      "Chat attachment store directory",
    );
    this.objectsDirectory = path.join(rootDirectory, "objects");
  }

  /**
   * @param {string} filePath
   * @returns {boolean}
   */
  manages(filePath: string): boolean {
    const normalized = path.resolve(filePath);
    return path.dirname(normalized) === this.objectsDirectory;
  }

  /**
   * @param {unknown} sourcePath
   * @returns {Promise<{ kind: 'image' | 'file', name: string, path: string }>}
   */
  async importFile(
    sourcePath: unknown,
  ): Promise<{ kind: "image" | "file"; name: string; path: string }> {
    const source = absolutePath(sourcePath, "Chat attachment path");
    await regularFileStats(source);
    if (this.manages(source)) {
      return {
        kind: chatAttachmentKind(source),
        name: path.basename(source),
        path: source,
      };
    }

    await mkdir(this.objectsDirectory, { recursive: true });
    const temporaryPath = path.join(
      this.objectsDirectory,
      `.${randomUUID()}.tmp`,
    );
    let destination = "";
    try {
      await copyFile(source, temporaryPath);
      const temporaryStats = await regularFileStats(temporaryPath);
      const contentHash = await sha256(temporaryPath);
      destination = path.join(
        this.objectsDirectory,
        `${contentHash}${storedExtension(source)}`,
      );
      if (
        !(await matchesStoredFile(
          destination,
          contentHash,
          temporaryStats.size,
        ))
      ) {
        try {
          await rename(temporaryPath, destination);
        } catch (error) {
          if (
            !(await matchesStoredFile(
              destination,
              contentHash,
              temporaryStats.size,
            ))
          )
            throw error;
        }
      }
    } finally {
      await rm(temporaryPath, { force: true });
    }

    return {
      kind: chatAttachmentKind(source),
      name: path.basename(source),
      path: destination,
    };
  }

  /**
   * @param {unknown} value
   * @returns {Promise<{ kind: 'image' | 'file', name: string, path: string }>}
   */
  async importAttachment(
    value: unknown,
  ): Promise<{ kind: "image" | "file"; name: string; path: string }> {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new TypeError("Chat attachment must be an object.");
    }
    const kind = "kind" in value ? value.kind : null;
    const name = "name" in value ? value.name : null;
    const sourcePath = "path" in value ? value.path : null;
    if (kind !== "image" && kind !== "file")
      throw new TypeError("Chat attachment kind is invalid.");
    if (typeof name !== "string" || !name.trim()) {
      throw new TypeError("Chat attachment name must be a non-empty string.");
    }
    const stored = await this.importFile(sourcePath);
    return { kind, name: name.trim(), path: stored.path };
  }

  /**
   * @param {unknown[]} values
   * @returns {Promise<Array<{ kind: 'image' | 'file', name: string, path: string }>>}
   */
  async importAttachments(
    values: unknown[],
  ): Promise<Array<{ kind: "image" | "file"; name: string; path: string }>> {
    return Promise.all(values.map((value) => this.importAttachment(value)));
  }

  /**
   * @param {string[]} filePaths
   * @returns {Promise<Array<{ kind: 'image' | 'file', name: string, path: string }>>}
   */
  async importFiles(
    filePaths: string[],
  ): Promise<Array<{ kind: "image" | "file"; name: string; path: string }>> {
    return Promise.all(filePaths.map((filePath) => this.importFile(filePath)));
  }

  async importTransferredFiles(value: unknown): Promise<Array<{ kind: 'image' | 'file'; name: string; path: string }>> {
    const transfers = validatedChatAttachmentTransfers(value);
    // Validate all filesystem sources before writing any incoming attachment.
    await Promise.all(transfers.map((transfer) => 'path' in transfer ? regularFileStats(transfer.path) : undefined));
    const attachments: Array<{ kind: 'image' | 'file'; name: string; path: string }> = [];
    for (const transfer of transfers) {
      if ('path' in transfer) {
        attachments.push(await this.importFile(transfer.path));
        continue;
      }
      await mkdir(this.objectsDirectory, { recursive: true });
      const contentHash = createHash('sha256').update(transfer.bytes).digest('hex');
      const destination = path.join(this.objectsDirectory, `${contentHash}${storedExtension(transfer.name)}`);
      if (!(await matchesStoredFile(destination, contentHash, transfer.bytes.byteLength))) {
        const temporaryPath = path.join(this.objectsDirectory, `.${randomUUID()}.tmp`);
        try {
          await writeFile(temporaryPath, transfer.bytes, { flag: 'wx', mode: 0o600 });
          await rename(temporaryPath, destination);
        } finally {
          await rm(temporaryPath, { force: true });
        }
      }
      attachments.push({ kind: chatAttachmentKind(destination), name: transfer.name, path: destination });
    }
    return attachments;
  }
}

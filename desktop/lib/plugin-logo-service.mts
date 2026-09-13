import { Buffer } from "node:buffer";
import { readFile, stat } from "node:fs/promises";
import { extname, isAbsolute } from "node:path";

const MAX_PLUGIN_LOGO_BYTES = 2 * 1024 * 1024;
const MAX_REMOTE_REDIRECTS = 3;
const REMOTE_LOGO_TIMEOUT_MS = 10_000;
const ALLOWED_REMOTE_LOGO_HOSTS = new Set(["files.openai.com", "chatgpt.com"]);
const IMAGE_MIME_TYPES = new Set([
  "image/avif",
  "image/gif",
  "image/jpeg",
  "image/png",
  "image/svg+xml",
  "image/webp",
]);
const LOCAL_IMAGE_MIME_TYPES = new Map([
  [".avif", "image/avif"],
  [".gif", "image/gif"],
  [".jpeg", "image/jpeg"],
  [".jpg", "image/jpeg"],
  [".png", "image/png"],
  [".svg", "image/svg+xml"],
  [".webp", "image/webp"],
]);

type PluginLogoSource = { kind: "local" | "remote"; value: string };

/**
 * @param {unknown} value
 * @returns {URL | null}
 */
function allowedRemoteLogoUrl(value: unknown): URL | null {
  if (typeof value !== "string" || !value.trim()) return null;
  try {
    const url = new URL(value);
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      (url.port && url.port !== "443") ||
      !ALLOWED_REMOTE_LOGO_HOSTS.has(url.hostname.toLocaleLowerCase())
    )
      return null;
    return url;
  } catch {
    return null;
  }
}

/**
 * @param {unknown} value
 * @returns {boolean}
 */
export function isAllowedRemotePluginLogoUrl(value: unknown): boolean {
  return allowedRemoteLogoUrl(value) !== null;
}

/**
 * @param {Buffer<ArrayBufferLike>} data
 * @param {string} mimeType
 * @returns {string}
 */
function imageDataUrl(data: Buffer<ArrayBufferLike>, mimeType: string): string {
  return `data:${mimeType};base64,${data.toString("base64")}`;
}

/**
 * @param {string} filePath
 * @returns {Promise<string | null>}
 */
async function localPluginLogoDataUrl(
  filePath: string,
): Promise<string | null> {
  if (!isAbsolute(filePath)) return null;
  const mimeType = LOCAL_IMAGE_MIME_TYPES.get(
    extname(filePath).toLocaleLowerCase(),
  );
  if (!mimeType) return null;
  const metadata = await stat(filePath);
  if (
    !metadata.isFile() ||
    metadata.size <= 0 ||
    metadata.size > MAX_PLUGIN_LOGO_BYTES
  )
    return null;
  const fileData = await readFile(filePath);
  const data = Buffer.from(fileData);
  return imageDataUrl(data, mimeType);
}

/**
 * @param {URL} initialUrl
 * @returns {Promise<Response | null>}
 */
async function fetchRemotePluginLogo(
  initialUrl: URL,
): Promise<Response | null> {
  let currentUrl = initialUrl;
  for (
    let redirectCount = 0;
    redirectCount <= MAX_REMOTE_REDIRECTS;
    redirectCount += 1
  ) {
    const response = await fetch(currentUrl, {
      headers: {
        Accept: "image/avif,image/webp,image/png,image/svg+xml,image/*;q=0.8",
      },
      redirect: "manual",
      signal: AbortSignal.timeout(REMOTE_LOGO_TIMEOUT_MS),
    });
    if (response.status < 300 || response.status >= 400) return response;
    const location = response.headers.get("location");
    const nextUrl = location
      ? allowedRemoteLogoUrl(new URL(location, currentUrl).href)
      : null;
    if (!nextUrl) return null;
    currentUrl = nextUrl;
  }
  return null;
}

/**
 * @param {string} value
 * @returns {Promise<string | null>}
 */
async function remotePluginLogoDataUrl(value: string): Promise<string | null> {
  const url = allowedRemoteLogoUrl(value);
  if (!url) return null;
  const response = await fetchRemotePluginLogo(url);
  if (!response?.ok) return null;
  const mimeType =
    response.headers
      .get("content-type")
      ?.split(";", 1)[0]
      ?.trim()
      .toLocaleLowerCase() ?? "";
  if (!IMAGE_MIME_TYPES.has(mimeType)) return null;
  const contentLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > MAX_PLUGIN_LOGO_BYTES)
    return null;
  const data = Buffer.from(await response.arrayBuffer());
  if (data.length <= 0 || data.length > MAX_PLUGIN_LOGO_BYTES) return null;
  return imageDataUrl(data, mimeType);
}

/**
 * @param {PluginLogoSource | null} source
 * @returns {Promise<string | null>}
 */
export async function pluginLogoDataUrl(
  source: PluginLogoSource | null,
): Promise<string | null> {
  if (!source) return null;
  try {
    if (source.kind === "local")
      return await localPluginLogoDataUrl(source.value);
    if (source.kind === "remote")
      return await remotePluginLogoDataUrl(source.value);
    return null;
  } catch {
    return null;
  }
}

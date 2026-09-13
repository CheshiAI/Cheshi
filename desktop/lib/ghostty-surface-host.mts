import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const CURRENT_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
const FRAME_EPSILON = 0.25;
type SplitDirection = "right" | "left" | "down" | "up";
interface SurfaceFrame {
  x: number;
  y: number;
  width: number;
  height: number;
}
interface SurfaceState {
  frame: SurfaceFrame;
  occluded: boolean | null;
  focused: boolean | null;
}
interface NativeWindowOwner {
  getNativeWindowHandle(): Buffer;
}
interface GhosttyBinding {
  initialize(fontDirectory: string): boolean;
  setDark(dark: boolean): void;
  setEventHandler(handler: (event: unknown) => void): void;
  createSurface(
    handle: Buffer,
    frame: SurfaceFrame,
    workingDirectory: string,
    dark: boolean,
  ): number;
  resizeSurface(surfaceId: number, frame: SurfaceFrame): void;
  setOccluded(surfaceId: number, occluded: boolean): void;
  setFocus(surfaceId: number, focused: boolean): void;
  destroySurface(surfaceId: number): void;
}
type NativeEventListener = (event: unknown) => void;
const bindingListeners = new WeakMap<GhosttyBinding, Set<NativeEventListener>>();

function subscribeNativeEvents(binding: GhosttyBinding, listener: NativeEventListener) {
  let listeners = bindingListeners.get(binding);
  if (!listeners) {
    const subscribers = new Set<NativeEventListener>();
    // The native addon exposes one process-wide callback. Share it across windows.
    binding.setEventHandler((event) => {
      for (const subscriber of subscribers) subscriber(event);
    });
    bindingListeners.set(binding, subscribers);
    listeners = subscribers;
  }
  listeners.add(listener);
  return () => listeners.delete(listener);
}

interface GhosttySurfaceHostOptions {
  owner: NativeWindowOwner;
  fontDirectory?: string;
  workingDirectory: string;
  dark?: boolean;
  onFocus?: (paneId: string) => void;
  onSplit?: (paneId: string, direction: SplitDirection) => void;
  onClose?: (paneId: string) => void;
  onTitle?: (paneId: string, title: string) => void;
  onError?: (error: Error) => void;
  binding?: GhosttyBinding | null;
}
const VALID_SPLIT_DIRECTIONS = new Set<SplitDirection>([
  "right",
  "left",
  "down",
  "up",
]);

function isLiteralTrue(value: unknown): value is true {
  return value === true;
}

function loadBinding(): GhosttyBinding | null {
  if (process.platform !== "darwin") return null;
  const require = createRequire(import.meta.url);
  return require(
    path.join(
      CURRENT_DIRECTORY,
      "electron-libghostty",
      "native",
      "cheshi_ghostty.node",
    ),
  ) as GhosttyBinding;
}

function validFrame(frame: unknown): frame is SurfaceFrame {
  if (!frame || typeof frame !== "object") return false;
  const value = frame as Partial<SurfaceFrame>;
  return (
    [value.x, value.y, value.width, value.height].every(Number.isFinite) &&
    typeof value.width === "number" &&
    value.width >= 2 &&
    typeof value.height === "number" &&
    value.height >= 2
  );
}

function assertValidSurfaceId(surfaceId: unknown): asserts surfaceId is number {
  if (
    typeof surfaceId === "number" &&
    Number.isInteger(surfaceId) &&
    surfaceId >= 0
  )
    return;
  throw new Error("Ghostty did not create a native surface.");
}

function sameFrame(left: SurfaceFrame | undefined, right: SurfaceFrame) {
  return (
    left !== undefined &&
    Math.abs(left.x - right.x) < FRAME_EPSILON &&
    Math.abs(left.y - right.y) < FRAME_EPSILON &&
    Math.abs(left.width - right.width) < FRAME_EPSILON &&
    Math.abs(left.height - right.height) < FRAME_EPSILON
  );
}

function copyFrame(frame: SurfaceFrame): SurfaceFrame {
  return {
    x: frame.x,
    y: frame.y,
    width: frame.width,
    height: frame.height,
  };
}

export class GhosttySurfaceHost {
  windowVisible: boolean;
  pageVisible: boolean;
  activePaneId: string | null;
  visiblePaneIds: Set<string>;
  paneVisibility: Map<string, boolean>;
  panesBySurface: Map<number, string>;
  surfaceStates: Map<string, SurfaceState>;
  surfaces: Map<string, number>;
  binding: GhosttyBinding | null;
  onError?: (error: Error) => void;
  onTitle?: (paneId: string, title: string) => void;
  onClose?: (paneId: string) => void;
  onSplit?: (paneId: string, direction: SplitDirection) => void;
  onFocus?: (paneId: string) => void;
  dark: boolean;
  workingDirectory: string;
  owner: NativeWindowOwner;
  private unsubscribeNativeEvents: (() => void) | null = null;
  constructor({
    owner,
    fontDirectory = "",
    workingDirectory,
    dark = false,
    onFocus,
    onSplit,
    onClose,
    onTitle,
    onError,
    binding = loadBinding(),
  }: GhosttySurfaceHostOptions) {
    this.owner = owner;
    this.workingDirectory = workingDirectory;
    this.dark = isLiteralTrue(dark);
    this.onFocus = onFocus;
    this.onSplit = onSplit;
    this.onClose = onClose;
    this.onTitle = onTitle;
    this.onError = onError;
    this.binding = binding;
    this.surfaces = new Map();
    this.surfaceStates = new Map();
    this.panesBySurface = new Map();
    this.paneVisibility = new Map();
    this.visiblePaneIds = new Set();
    this.activePaneId = null;
    this.pageVisible = false;
    this.windowVisible = true;

    if (!this.binding) return;
    if (!this.binding.initialize(fontDirectory)) {
      throw new Error(
        "Could not initialize the Ghostty native surface bridge.",
      );
    }
    this.binding.setDark(this.dark);
    this.unsubscribeNativeEvents = subscribeNativeEvents(this.binding, (event) => this.handleEvent(event));
  }

  get available() {
    return this.binding !== null;
  }

  updatePane(paneId: unknown, frame: unknown, visible: boolean) {
    if (!this.binding || typeof paneId !== "string") return;
    this.paneVisibility.set(paneId, isLiteralTrue(visible));
    const shouldShow = this.shouldShowPane(paneId);
    let surfaceId = this.surfaces.get(paneId);
    if (!validFrame(frame)) {
      if (surfaceId !== undefined) {
        this.applySurfaceState(paneId, surfaceId, false);
      }
      return;
    }
    try {
      if (surfaceId === undefined) {
        if (!shouldShow || typeof this.workingDirectory !== "string") return;
        surfaceId = this.binding.createSurface(
          this.owner.getNativeWindowHandle(),
          frame,
          this.workingDirectory,
          this.dark,
        );
        assertValidSurfaceId(surfaceId);
        this.surfaces.set(paneId, surfaceId);
        this.panesBySurface.set(surfaceId, paneId);
        this.surfaceStates.set(paneId, {
          frame: copyFrame(frame),
          occluded: null,
          focused: null,
        });
      } else if (!sameFrame(this.surfaceStates.get(paneId)?.frame, frame)) {
        this.binding.resizeSurface(surfaceId, frame);
        const state = this.surfaceStates.get(paneId);
        if (state) state.frame = copyFrame(frame);
      }
      this.applySurfaceState(paneId, surfaceId, shouldShow);
    } catch (error) {
      this.reportError(error);
    }
  }

  sync({
    paneIds,
    visiblePaneIds,
    activePaneId,
    pageVisible,
  }: {
    paneIds: string[];
    visiblePaneIds: string[];
    activePaneId: string | null;
    pageVisible: boolean;
  }) {
    const validPaneIds = new Set(paneIds);
    this.visiblePaneIds = new Set(visiblePaneIds);
    this.activePaneId = activePaneId;
    this.pageVisible = isLiteralTrue(pageVisible);
    for (const paneId of this.surfaces.keys()) {
      if (!validPaneIds.has(paneId)) this.destroyPane(paneId);
    }
    for (const [paneId, surfaceId] of this.surfaces) {
      this.applySurfaceState(paneId, surfaceId, this.shouldShowPane(paneId));
    }
  }

  setDark(dark: boolean) {
    const nextDark = isLiteralTrue(dark);
    if (this.dark === nextDark) return;
    this.dark = nextDark;
    // The native bridge also pins AppKit appearance to the explicit Cheshi theme.
    this.binding?.setDark(this.dark);
  }

  setWindowVisible(visible: boolean) {
    this.windowVisible = isLiteralTrue(visible);
    for (const [paneId, surfaceId] of this.surfaces) {
      this.applySurfaceState(paneId, surfaceId, this.shouldShowPane(paneId));
    }
  }

  destroyPane(paneId: string) {
    const surfaceId = this.surfaces.get(paneId);
    if (surfaceId === undefined) return;
    this.surfaces.delete(paneId);
    this.surfaceStates.delete(paneId);
    this.panesBySurface.delete(surfaceId);
    this.paneVisibility.delete(paneId);
    try {
      this.binding?.destroySurface(surfaceId);
    } catch (error) {
      this.reportError(error);
    }
  }

  close() {
    this.unsubscribeNativeEvents?.();
    this.unsubscribeNativeEvents = null;
    for (const paneId of [...this.surfaces.keys()]) this.destroyPane(paneId);
    this.paneVisibility.clear();
    this.visiblePaneIds.clear();
    this.surfaceStates.clear();
  }

  shouldShowPane(paneId: string) {
    return (
      this.paneVisibility.get(paneId) === true &&
      this.visiblePaneIds.has(paneId) &&
      this.pageVisible &&
      this.windowVisible
    );
  }

  applySurfaceState(paneId: string, surfaceId: number, visible: boolean) {
    if (!this.binding) return;
    const state = this.surfaceStates.get(paneId);
    if (!state) return;
    const occluded = !visible;
    if (state.occluded !== occluded) {
      this.binding.setOccluded(surfaceId, occluded);
      state.occluded = occluded;
    }
    const focused = !occluded && paneId === this.activePaneId;
    if (state.focused !== focused) {
      this.binding.setFocus(surfaceId, focused);
      state.focused = focused;
    }
  }

  handleEvent(event: unknown) {
    if (!event || typeof event !== "object") return;
    const valueRecord = event as Record<string, unknown>;
    if (
      typeof valueRecord.surfaceId !== "number" ||
      typeof valueRecord.type !== "string"
    )
      return;
    const paneId = this.panesBySurface.get(valueRecord.surfaceId);
    if (!paneId) return;
    const value =
      typeof valueRecord.value === "string" ? valueRecord.value : "";
    setImmediate(() => {
      if (!this.surfaces.has(paneId)) return;
      switch (valueRecord.type) {
        case "focus":
          this.onFocus?.(paneId);
          return;
        case "split-request":
          if (VALID_SPLIT_DIRECTIONS.has(value as SplitDirection))
            this.onSplit?.(paneId, value as SplitDirection);
          return;
        case "set-title":
          this.onTitle?.(paneId, value);
          return;
        case "surface-exit":
          this.onClose?.(paneId);
          return;
        default:
          return;
      }
    });
  }

  reportError(error: unknown) {
    this.onError?.(error instanceof Error ? error : new Error(String(error)));
  }
}

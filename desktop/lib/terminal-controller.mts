import { randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";

type SplitDirection = "right" | "left" | "down" | "up";
type TerminalAxis = "columns" | "rows";
type TerminalLayout = TerminalPaneLayout | TerminalSplitLayout;

interface TerminalPaneLayout {
  type: "pane";
  paneId: string;
}

interface TerminalSplitLayout {
  type: "split";
  id: string;
  axis: TerminalAxis;
  ratio: number;
  first: TerminalLayout;
  second: TerminalLayout;
}

interface TerminalPane {
  id: string;
  sessionId: string;
  title: string;
  running: boolean;
}

interface TerminalSession {
  id: string;
  ordinal: number;
  title: string;
  panes: TerminalPane[];
  layout: TerminalLayout | null;
}

const SPLIT_DIRECTIONS = new Set<SplitDirection>([
  "right",
  "left",
  "down",
  "up",
]);
const DEFAULT_SPLIT_RATIO = 0.5;
const MIN_SPLIT_RATIO = 0.1;
const MAX_SPLIT_RATIO = 0.9;

/** @returns {string} */
function createTerminalId(): string {
  return randomUUID();
}

function containsPane(layout: TerminalLayout | null, paneId: unknown): boolean {
  if (!layout) return false;
  if (layout.type === "pane") return layout.paneId === paneId;
  return (
    containsPane(layout.first, paneId) || containsPane(layout.second, paneId)
  );
}

function containsSplit(
  layout: TerminalLayout | null,
  splitId: string,
): boolean {
  if (!layout || layout.type === "pane") return false;
  return (
    layout.id === splitId ||
    containsSplit(layout.first, splitId) ||
    containsSplit(layout.second, splitId)
  );
}

function validSplitRatio(ratio: unknown): ratio is number {
  return (
    typeof ratio === "number" &&
    Number.isFinite(ratio) &&
    ratio >= MIN_SPLIT_RATIO &&
    ratio <= MAX_SPLIT_RATIO
  );
}

export function insertTerminalPane(
  layout: TerminalLayout | null,
  targetPaneId: string,
  newPaneId: string,
  direction: SplitDirection,
  splitId = createTerminalId(),
): TerminalLayout | null {
  if (!layout) return layout;
  if (layout.type === "pane") {
    if (layout.paneId !== targetPaneId) return layout;
    const target: TerminalPaneLayout = { type: "pane", paneId: targetPaneId };
    const inserted: TerminalPaneLayout = { type: "pane", paneId: newPaneId };
    const insertBeforeTarget = direction === "left" || direction === "up";
    return {
      type: "split",
      id: splitId,
      axis: direction === "left" || direction === "right" ? "columns" : "rows",
      ratio: DEFAULT_SPLIT_RATIO,
      first: insertBeforeTarget ? inserted : target,
      second: insertBeforeTarget ? target : inserted,
    };
  }
  if (containsPane(layout.first, targetPaneId)) {
    return {
      ...layout,
      first:
        insertTerminalPane(
          layout.first,
          targetPaneId,
          newPaneId,
          direction,
          splitId,
        ) ?? layout.first,
    };
  }
  if (containsPane(layout.second, targetPaneId)) {
    return {
      ...layout,
      second:
        insertTerminalPane(
          layout.second,
          targetPaneId,
          newPaneId,
          direction,
          splitId,
        ) ?? layout.second,
    };
  }
  return layout;
}

export function resizeTerminalSplit(
  layout: TerminalLayout | null,
  splitId: string,
  ratio: unknown,
): TerminalLayout | null {
  if (!layout || layout.type === "pane" || !validSplitRatio(ratio))
    return layout;
  if (layout.id === splitId) {
    return layout.ratio === ratio ? layout : { ...layout, ratio };
  }
  const first = resizeTerminalSplit(layout.first, splitId, ratio);
  if (first !== layout.first)
    return { ...layout, first: first ?? layout.first };
  const second = resizeTerminalSplit(layout.second, splitId, ratio);
  return second === layout.second
    ? layout
    : { ...layout, second: second ?? layout.second };
}

export function removeTerminalPane(
  layout: TerminalLayout | null,
  paneId: string,
): TerminalLayout | null {
  if (!layout) return null;
  if (layout.type === "pane") return layout.paneId === paneId ? null : layout;
  const first = removeTerminalPane(layout.first, paneId);
  const second = removeTerminalPane(layout.second, paneId);
  if (!first) return second;
  if (!second) return first;
  return { ...layout, first, second };
}

function firstPaneId(layout: TerminalLayout | null): string | null {
  if (!layout) return null;
  return layout.type === "pane" ? layout.paneId : firstPaneId(layout.first);
}

function nextSessionOrdinal(sessions: TerminalSession[]) {
  return (
    sessions.reduce(
      (highest, session) => Math.max(highest, session.ordinal),
      0,
    ) + 1
  );
}

function terminalTitle(cwd: string) {
  const homeDirectory = os.homedir();
  const displayPath =
    cwd === homeDirectory
      ? "~"
      : cwd.startsWith(`${homeDirectory}${path.sep}`)
        ? `~${cwd.slice(homeDirectory.length)}`
        : cwd;
  const hostname = os.hostname().split(".")[0] || "localhost";
  return `${os.userInfo().username}@${hostname}:${displayPath}`;
}

export class TerminalController {
  activePaneId: string | null;
  activeSessionId: string | null;
  sessions: TerminalSession[];
  cwd: string | null;
  onStateChanged: (state: object) => void;
  /** @param {{ onStateChanged?: (state: object) => void }} [options] */
  constructor({
    onStateChanged,
  }: { onStateChanged?: (state: object) => void } = {}) {
    this.onStateChanged =
      typeof onStateChanged === "function" ? onStateChanged : () => {};
    this.cwd = null;
    this.sessions = [];
    this.activeSessionId = null;
    this.activePaneId = null;
  }

  open(cwd: unknown) {
    if (typeof cwd !== "string" || !path.isAbsolute(cwd)) return false;
    if (this.cwd === cwd && this.sessions.length > 0) return true;
    this.close(false);
    this.cwd = cwd;
    this.newSession();
    return true;
  }

  newSession() {
    if (!this.cwd) return null;
    const ordinal = nextSessionOrdinal(this.sessions);
    const sessionId = createTerminalId();
    const pane = this.createPane(sessionId);
    const session: TerminalSession = {
      id: sessionId,
      ordinal,
      title: `Terminal ${ordinal}`,
      panes: [pane],
      layout: { type: "pane", paneId: pane.id },
    };
    this.sessions.push(session);
    this.activeSessionId = session.id;
    this.activePaneId = pane.id;
    this.emitState();
    return session.id;
  }

  selectSession(sessionId: unknown) {
    const session = this.sessions.find(
      (candidate) => candidate.id === sessionId,
    );
    if (!session) return false;
    if (this.activeSessionId === session.id) return true;
    this.activeSessionId = session.id;
    this.activePaneId = firstPaneId(session.layout);
    this.emitState();
    return true;
  }

  selectPane(sessionId: unknown, paneId: unknown) {
    if (typeof paneId !== "string") return false;
    const session = this.sessions.find(
      (candidate) => candidate.id === sessionId,
    );
    if (!session?.panes.some((pane: { id: any }) => pane.id === paneId))
      return false;
    if (this.activeSessionId === session.id && this.activePaneId === paneId)
      return true;
    this.activeSessionId = session.id;
    this.activePaneId = paneId;
    this.emitState();
    return true;
  }

  splitPane(sessionId: unknown, paneId: unknown, direction: unknown) {
    if (
      typeof paneId !== "string" ||
      typeof direction !== "string" ||
      !SPLIT_DIRECTIONS.has(direction as SplitDirection)
    )
      return null;
    const session = this.sessions.find(
      (candidate) => candidate.id === sessionId,
    );
    if (!session || !containsPane(session.layout, paneId) || !this.cwd)
      return null;
    const pane = this.createPane(session.id);
    session.panes.push(pane);
    session.layout = insertTerminalPane(
      session.layout,
      paneId,
      pane.id,
      direction as SplitDirection,
    );
    this.activeSessionId = session.id;
    this.activePaneId = pane.id;
    this.emitState();
    return pane.id;
  }

  resizeSplit(sessionId: unknown, splitId: unknown, ratio: unknown) {
    if (typeof splitId !== "string" || !splitId || !validSplitRatio(ratio))
      return false;
    const session = this.sessions.find(
      (candidate) => candidate.id === sessionId,
    );
    if (!session || !containsSplit(session.layout, splitId)) return false;
    const layout = resizeTerminalSplit(session.layout, splitId, ratio);
    if (layout === session.layout) return true;
    session.layout = layout;
    this.emitState();
    return true;
  }

  closePane(sessionId: unknown, paneId: unknown) {
    if (typeof paneId !== "string") return false;
    const session = this.sessions.find(
      (candidate) => candidate.id === sessionId,
    );
    const pane = session?.panes.find(
      (candidate: { id: any }) => candidate.id === paneId,
    );
    if (!session || !pane) return false;
    session.panes = session.panes.filter(
      (candidate: { id: any }) => candidate.id !== paneId,
    );
    session.layout = removeTerminalPane(session.layout, paneId);
    if (session.panes.length === 0 || !session.layout) {
      return this.closeSession(session.id);
    }
    if (this.activePaneId === paneId)
      this.activePaneId = firstPaneId(session.layout);
    this.emitState();
    return true;
  }

  closeSession(sessionId: unknown) {
    const session = this.sessions.find(
      (candidate) => candidate.id === sessionId,
    );
    if (!session) return false;
    this.sessions = this.sessions.filter(
      (candidate) => candidate.id !== sessionId,
    );
    if (this.activeSessionId === sessionId) {
      const replacement = this.sessions.at(-1) ?? null;
      this.activeSessionId = replacement?.id ?? null;
      this.activePaneId = firstPaneId(replacement?.layout ?? null);
    }
    this.emitState();
    return true;
  }

  setPaneTitle(paneId: unknown, title: unknown) {
    if (typeof title !== "string") return false;
    const trimmed = title.trim();
    if (!trimmed || trimmed.length > 512) return false;
    const pane = this.findPane(paneId);
    if (!pane || pane.title === trimmed) return false;
    pane.title = trimmed;
    this.emitState();
    return true;
  }

  findPane(paneId: unknown): TerminalPane | null {
    for (const session of this.sessions) {
      const pane = session.panes.find(
        (candidate: { id: any }) => candidate.id === paneId,
      );
      if (pane) return pane;
    }
    return null;
  }

  handleSurfaceExit(paneId: unknown) {
    const pane = this.findPane(paneId);
    if (!pane) return false;
    pane.running = false;
    return this.closePane(pane.sessionId, pane.id);
  }

  close(emitState = true) {
    this.sessions = [];
    this.activeSessionId = null;
    this.activePaneId = null;
    this.cwd = null;
    if (emitState) this.emitState();
  }

  snapshot() {
    return {
      cwd: this.cwd,
      sessions: this.sessions.map((session) => ({
        id: session.id,
        title: session.title,
        layout: session.layout,
        panes: session.panes.map(
          (pane: { id: any; title: any; running: any }) => ({
            id: pane.id,
            title: pane.title,
            running: pane.running,
          }),
        ),
      })),
      activeSessionId: this.activeSessionId,
      activePaneId: this.activePaneId,
    };
  }

  createPane(sessionId: string): TerminalPane {
    if (!this.cwd) throw new Error("Terminal workspace is not open.");
    return {
      id: createTerminalId(),
      sessionId,
      title: terminalTitle(this.cwd),
      running: true,
    };
  }

  emitState() {
    this.onStateChanged(this.snapshot());
  }
}

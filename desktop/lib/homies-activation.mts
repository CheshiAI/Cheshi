import { parseHomiesEnabled } from '../shared/settings.ts';
import { homiesReady, type HomieSetupStatus } from '../shared/homie-setup.ts';

export interface HomiesAccess {
  available(): boolean;
  run<T>(operation: () => T | Promise<T>): Promise<T>;
  background(operation: () => Promise<void>): Promise<void>;
}
export function assertHomiesAvailable(access?: HomiesAccess): void {
  if (access?.available() === false) throw new Error('Enable Homies in Settings before using Worker or Docker.');
}
const busyMessage = 'Homies has active or unresolved work. Finish or inspect the work and close worker terminals before turning it off.';
export class HomiesActivation implements HomiesAccess {
  private enabled = false;
  private changing = false;
  private active = 0;
  private readonly listeners = new Set<(enabled: boolean) => void>();
  private readonly options: {
    preferences: { getHomiesEnabled(): boolean; setHomiesEnabled(value: boolean): boolean };
    inspect(): Promise<HomieSetupStatus>;
    assertIdle(): Promise<void>;
  };
  constructor(options: HomiesActivation['options']) { this.options = options; }
  getHomiesEnabled = () => this.enabled;
  available = () => this.enabled && !this.changing;
  subscribeHomiesEnabled = (listener: (enabled: boolean) => void) => {
    this.listeners.add(listener); return () => { this.listeners.delete(listener); };
  };
  hold() {
    assertHomiesAvailable(this);
    this.active++;
    let released = false;
    return () => { if (!released) { released = true; this.active--; } };
  }
  runSync<T>(operation: () => T): T {
    const release = this.hold();
    try { return operation(); } finally { release(); }
  }
  async run<T>(operation: () => T | Promise<T>): Promise<T> {
    const release = this.hold();
    try { return await operation(); } finally { release(); }
  }
  async background(operation: () => Promise<void>): Promise<void> {
    if (this.available()) await this.run(operation);
  }
  async restore() {
    if (!this.options.preferences.getHomiesEnabled()) return;
    try { await this.setHomiesEnabled(true); }
    catch { this.options.preferences.setHomiesEnabled(false); }
  }
  async setHomiesEnabled(value: unknown): Promise<boolean> {
    const enabled = parseHomiesEnabled(value);
    if (this.changing) throw new Error('A Homies setting change is in progress. Try again shortly.');
    if (enabled === this.enabled) return this.enabled;
    if (!enabled && this.active > 0) throw new Error(busyMessage);
    this.changing = true;
    try {
      if (enabled) {
        const status = await this.options.inspect();
        if (!homiesReady(status)) throw new Error('Install Homebrew, Docker CLI and Colima, then use Prepare Homies in Settings to verify the connection and security profile before enabling Homies.');
      } else await this.options.assertIdle();
      this.options.preferences.setHomiesEnabled(enabled);
      this.enabled = enabled;
    } finally {
      this.changing = false;
      // A rejected OFF transition may have consumed queued notifications while paused.
      // Reannounce the retained state so the host resumes reconciliation in that case too.
      for (const listener of this.listeners) listener(this.enabled);
    }
    return this.enabled;
  }
}
export function assertHomiesWorkSettled(pending: boolean): void {
  if (pending) throw new Error(busyMessage);
}

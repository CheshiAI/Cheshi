import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { MAX_RECORDING_BYTES, MAX_RECORDING_FRAMES, MAX_RECORDING_SECONDS, type SavedSkillRecording } from '../shared/plugin-actions.ts';

export class SkillRecordingStore {
  private readonly directory: string;

  constructor(directory: string) {
    this.directory = directory;
  }

  async save(value: unknown): Promise<SavedSkillRecording> {
    if (!value || typeof value !== 'object') throw new TypeError('Invalid recording.');
    const recording = value as Record<string, unknown>;
    if (!(recording.video instanceof Uint8Array) || recording.video.byteLength < 4 || recording.video.byteLength > MAX_RECORDING_BYTES) {
      throw new TypeError('Recording video must be between 4 bytes and 64 MB.');
    }
    const video = Buffer.from(recording.video);
    if (video.readUInt32BE(0) !== 0x1a45dfa3) throw new TypeError('Recording must be WebM video.');
    const durationSeconds = recording.durationSeconds;
    if (typeof durationSeconds !== 'number' || !Number.isFinite(durationSeconds) || durationSeconds <= 0 || durationSeconds > MAX_RECORDING_SECONDS + 5) {
      throw new TypeError('Recording duration must be at most two minutes.');
    }
    if (!Array.isArray(recording.frames) || recording.frames.length < 1 || recording.frames.length > MAX_RECORDING_FRAMES) {
      throw new TypeError('Recording must contain between 1 and 18 preview frames.');
    }
    let previousSeconds = -1;
    const frames = recording.frames.map((value: unknown) => {
      if (!value || typeof value !== 'object') throw new TypeError('Invalid recording frame.');
      const frame = value as Record<string, unknown>;
      if (typeof frame.seconds !== 'number' || !Number.isFinite(frame.seconds) || frame.seconds < previousSeconds || frame.seconds < 0 || frame.seconds > durationSeconds) {
        throw new TypeError('Recording frame timestamps must be ordered and inside the recording.');
      }
      previousSeconds = frame.seconds;
      if (typeof frame.image !== 'string' || frame.image.length > 3_000_000 || !/^data:image\/jpeg;base64,[A-Za-z0-9+/]+={0,2}$/.test(frame.image)) {
        throw new TypeError('Recording frames must be bounded JPEG images.');
      }
      const bytes = Buffer.from(frame.image.slice('data:image/jpeg;base64,'.length), 'base64');
      if (bytes[0] !== 0xff || bytes[1] !== 0xd8 || bytes.at(-2) !== 0xff || bytes.at(-1) !== 0xd9) throw new TypeError('Invalid JPEG frame.');
      return { seconds: frame.seconds, bytes };
    });
    const id = randomUUID();
    const root = path.join(this.directory, id);
    await mkdir(root, { recursive: true, mode: 0o700 });
    try {
      await writeFile(path.join(root, 'recording.webm'), video, { flag: 'wx', mode: 0o600 });
      const manifest = [];
      for (const [index, frame] of frames.entries()) {
        const name = `frame-${index}.jpg`;
        await writeFile(path.join(root, name), frame.bytes, { flag: 'wx', mode: 0o600 });
        manifest.push({ seconds: frame.seconds, file: name });
      }
      await writeFile(path.join(root, 'recording.json'), JSON.stringify({ durationSeconds, frames: manifest }, null, 2), { flag: 'wx', mode: 0o600 });
      return { id, durationSeconds, frameCount: frames.length };
    } catch (error) {
      await rm(root, { recursive: true, force: true });
      throw error;
    }
  }

  async attachments(id: string): Promise<Array<{ kind: 'file' | 'image'; name: string; path: string }>> {
    if (!/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(id)) throw new TypeError('Invalid recording id.');
    const root = path.join(this.directory, id);
    const manifestPath = path.join(root, 'recording.json');
    const manifest: unknown = JSON.parse(await readFile(manifestPath, 'utf8'));
    if (!manifest || typeof manifest !== 'object' || !('frames' in manifest) || !Array.isArray(manifest.frames) || manifest.frames.length < 1 || manifest.frames.length > MAX_RECORDING_FRAMES) {
      throw new TypeError('Recording manifest is invalid.');
    }
    return [
      { kind: 'file', name: 'recording.json', path: manifestPath },
      { kind: 'file', name: 'recording.webm', path: path.join(root, 'recording.webm') },
      ...manifest.frames.map((frame: unknown, index: number) => {
        if (!frame || typeof frame !== 'object' || !('file' in frame) || frame.file !== `frame-${index}.jpg`) throw new TypeError('Recording frame path is invalid.');
        return { kind: 'image' as const, name: frame.file, path: path.join(root, frame.file) };
      }),
    ];
  }
}

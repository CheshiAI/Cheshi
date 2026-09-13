import { MAX_RECORDING_BYTES, MAX_RECORDING_FRAMES, MAX_RECORDING_SECONDS, type SkillRecordingFrame, type SkillRecordingUpload } from '../../../../shared/plugin-actions';

export interface SkillCapture {
  result: Promise<SkillRecordingUpload>;
  stop: () => void;
  cancel: () => void;
}

function recordingMimeType(): string {
  const mimeType = ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm'].find((type) => MediaRecorder.isTypeSupported(type));
  if (!mimeType) throw new Error('WebM recording is unavailable on this device.');
  return mimeType;
}

function recordingContext(canvas: HTMLCanvasElement): CanvasRenderingContext2D {
  const context = canvas.getContext('2d');
  if (!context) throw new Error('Recording preview could not be created.');
  return context;
}

export async function startSkillCapture(): Promise<SkillCapture> {
  const stream = await navigator.mediaDevices.getDisplayMedia({ audio: false, video: { frameRate: 10 } });
  const video = document.createElement('video');
  video.muted = true;
  video.srcObject = stream;
  const cleanupStream = () => {
    stream.getTracks().forEach((track) => track.stop());
    video.pause();
    video.srcObject = null;
  };
  try {
    await video.play();
    const mimeType = recordingMimeType();
    const recorder = new MediaRecorder(stream, { mimeType, videoBitsPerSecond: 1_000_000 });
    const canvas = document.createElement('canvas');
    const scale = Math.min(1, 1280 / video.videoWidth, 720 / video.videoHeight);
    canvas.width = Math.max(1, Math.round(video.videoWidth * scale));
    canvas.height = Math.max(1, Math.round(video.videoHeight * scale));
    const context = recordingContext(canvas);
    const frames: SkillRecordingFrame[] = [];
    const chunks: Blob[] = [];
    const startedAt = performance.now();
    let bytes = 0;
    let failure: Error | null = null;
    let stopping = false;
    let durationSeconds = 0;
    const seconds = () => Math.min((performance.now() - startedAt) / 1000, MAX_RECORDING_SECONDS);
    const captureFrame = () => {
      if (frames.length >= MAX_RECORDING_FRAMES || video.readyState < 2) return;
      context.drawImage(video, 0, 0, canvas.width, canvas.height);
      frames.push({ seconds: seconds(), image: canvas.toDataURL('image/jpeg', .8) });
    };
    let frameTimer: ReturnType<typeof setInterval> | undefined;
    let limitTimer: ReturnType<typeof setTimeout> | undefined;
    const stop = () => {
      if (stopping) return;
      stopping = true;
      clearInterval(frameTimer);
      clearTimeout(limitTimer);
      durationSeconds = seconds();
      try {
        captureFrame();
      } catch {
        failure = new Error('The recording preview could not be captured.');
      } finally {
        if (recorder.state !== 'inactive') recorder.stop();
        cleanupStream();
      }
    };
    const result = new Promise<SkillRecordingUpload>((resolve, reject) => {
      recorder.ondataavailable = ({ data }) => {
        bytes += data.size;
        if (bytes > MAX_RECORDING_BYTES) {
          failure = new Error('The recording exceeded 64 MB. Record a shorter workflow.');
          stop();
        } else if (data.size > 0) chunks.push(data);
      };
      recorder.onerror = () => {
        failure = new Error('Screen recording failed.');
        stop();
        reject(failure);
      };
      recorder.onstop = () => {
        clearInterval(frameTimer);
        clearTimeout(limitTimer);
        cleanupStream();
        if (failure) { reject(failure); return; }
        durationSeconds = Math.max(durationSeconds, frames.at(-1)?.seconds ?? 0);
        if (frames.length === 0) { reject(new Error('No screen frames were recorded. Try recording again.')); return; }
        void new Blob(chunks, { type: mimeType }).arrayBuffer().then(
          (buffer) => resolve({ video: new Uint8Array(buffer), frames, durationSeconds }),
          reject,
        );
      };
    });
    const captureSafely = () => {
      try {
        captureFrame();
      } catch {
        failure = new Error('The recording preview could not be captured.');
        stop();
      }
    };
    recorder.start(1000);
    captureSafely();
    if (!stopping) {
      frameTimer = setInterval(captureSafely, 8000);
      limitTimer = setTimeout(stop, MAX_RECORDING_SECONDS * 1000);
    }
    stream.getVideoTracks().forEach((track) => { track.onended = stop; });
    return {
      result,
      stop,
      cancel: () => { failure = new DOMException('Recording cancelled.', 'AbortError'); stop(); },
    };
  } catch (error) {
    cleanupStream();
    throw error;
  }
}

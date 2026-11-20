import type { TrackedHand } from '../core/hands';
import type { TrackingFrame } from '../core/tracking';

/**
 * Webcam tracking with MediaPipe: the face landmarker (blendshapes and the
 * facial transformation matrix) and, when asked, the hand landmarker (21
 * points per hand). Everything runs locally in the page: the
 * Wasm and the model files are served by Mochi Studio itself, and video
 * frames never leave this module.
 */
export interface FaceTrackerOptions {
  /** Folder that holds MediaPipe's Wasm files. */
  wasmBase: string;
  /** URL of face_landmarker.task. */
  modelUrl: string;
  /** URL of hand_landmarker.task. */
  handModelUrl: string;
}

export const DEFAULT_TRACKER_OPTIONS: FaceTrackerOptions = {
  wasmBase: new URL('mediapipe/wasm', document.baseURI).href,
  modelUrl: new URL('mediapipe/face_landmarker.task', document.baseURI).href,
  handModelUrl: new URL('mediapipe/hand_landmarker.task', document.baseURI).href,
};

/** What the camera tracks: the face, the hands, or both. */
export type TrackingMode = 'face' | 'hands' | 'both';
export const TRACKING_MODES: readonly TrackingMode[] = ['face', 'hands', 'both'];
const tracksFace = (m: TrackingMode): boolean => m !== 'hands';
const tracksHands = (m: TrackingMode): boolean => m !== 'face';

export class FaceTracker {
  private video: HTMLVideoElement;
  private stream: MediaStream | undefined;
  private landmarker: import('@mediapipe/tasks-vision').FaceLandmarker | undefined;
  private hands: import('@mediapipe/tasks-vision').HandLandmarker | undefined;
  private fileset: unknown;
  /** What the camera tracks; `setMode` changes it while it runs. */
  mode: TrackingMode = 'face';
  private running = false;
  private lastVideoTime = -1;
  private handle = 0;
  /** Detections per second, for the status display. */
  rate = 0;
  private rateCount = 0;
  private rateStart = 0;
  /**
   * No detection before this time. Detecting blocks the page; on a machine
   * without a graphics card MediaPipe runs on the CPU and a frame can take
   * most of a second, so after each one the page gets at least as long for
   * drawing, input and plugins (half the time at most goes to tracking; with
   * the GPU, a few milliseconds a frame, this never holds anything up).
   */
  private notBefore = 0;

  constructor(
    private onFrame: (f: TrackingFrame) => void,
    private opts: FaceTrackerOptions = DEFAULT_TRACKER_OPTIONS,
  ) {
    this.video = document.createElement('video');
    this.video.muted = true;
    this.video.playsInline = true;
  }

  get active(): boolean {
    return this.running;
  }

  /** The camera's video element, for an optional self-view. */
  get element(): HTMLVideoElement {
    return this.video;
  }

  /** MediaPipe's Wasm, loaded once for both landmarkers. */
  private async vision(): Promise<{
    lib: typeof import('@mediapipe/tasks-vision');
    fileset: Awaited<
      ReturnType<typeof import('@mediapipe/tasks-vision').FilesetResolver.forVisionTasks>
    >;
  }> {
    const lib = await import('@mediapipe/tasks-vision');
    this.fileset ??= await lib.FilesetResolver.forVisionTasks(this.opts.wasmBase);
    return { lib, fileset: this.fileset as never };
  }

  /** Loads the hand landmarker (two hands) the first time hands are tracked. */
  private async loadHands(): Promise<void> {
    if (this.hands) return;
    if (!(await served(this.opts.handModelUrl)))
      throw new Error('The hand model is missing. Run "npm run fetch:models" and reload.');
    const { lib, fileset } = await this.vision();
    const base = { runningMode: 'VIDEO' as const, numHands: 2 };
    try {
      this.hands = await lib.HandLandmarker.createFromOptions(fileset, {
        ...base,
        baseOptions: { modelAssetPath: this.opts.handModelUrl, delegate: 'GPU' },
      });
    } catch {
      this.hands = await lib.HandLandmarker.createFromOptions(fileset, {
        ...base,
        baseOptions: { modelAssetPath: this.opts.handModelUrl, delegate: 'CPU' },
      });
    }
  }

  /** Changes what the camera tracks (loading the hand model when first needed). */
  async setMode(mode: TrackingMode): Promise<void> {
    if (tracksHands(mode)) await this.loadHands();
    if (tracksFace(mode)) await this.loadFace();
    this.mode = mode;
  }

  /** Starts the camera (on a phone, `facingMode: 'user'` asks for the front camera). */
  async start(deviceId?: string, o: { facingMode?: 'user' } = {}): Promise<void> {
    if (this.running) return;
    if (tracksFace(this.mode)) await this.loadFace();
    if (tracksHands(this.mode)) await this.loadHands();
    this.stream = await navigator.mediaDevices.getUserMedia({
      video: {
        width: { ideal: 640 },
        height: { ideal: 480 },
        ...(deviceId ? { deviceId } : {}),
        ...(o.facingMode ? { facingMode: o.facingMode } : {}),
      },
      audio: false,
    });
    this.video.srcObject = this.stream;
    await this.video.play();
    this.running = true;
    this.rateStart = performance.now();
    this.loop();
  }

  private async loadFace(): Promise<void> {
    if (!this.landmarker) {
      if (!(await served(this.opts.modelUrl)))
        throw new Error('The face model is missing. Run "npm run fetch:models" and reload.');
      const { lib, fileset } = await this.vision();
      const { FaceLandmarker } = lib;
      const base = {
        runningMode: 'VIDEO' as const,
        numFaces: 1,
        outputFaceBlendshapes: true,
        outputFacialTransformationMatrixes: true,
      };
      try {
        this.landmarker = await FaceLandmarker.createFromOptions(fileset, {
          ...base,
          baseOptions: { modelAssetPath: this.opts.modelUrl, delegate: 'GPU' },
        });
      } catch {
        this.landmarker = await FaceLandmarker.createFromOptions(fileset, {
          ...base,
          baseOptions: { modelAssetPath: this.opts.modelUrl, delegate: 'CPU' },
        });
      }
    }
  }

  stop(): void {
    this.running = false;
    cancelAnimationFrame(this.handle);
    for (const t of this.stream?.getTracks() ?? []) t.stop();
    this.stream = undefined;
    this.video.srcObject = null;
    this.lastVideoTime = -1;
    this.notBefore = 0;
    this.rate = 0;
  }

  private loop = (): void => {
    if (!this.running) return;
    const now = performance.now();
    if (
      now >= this.notBefore &&
      this.video.readyState >= 2 &&
      this.video.currentTime !== this.lastVideoTime
    ) {
      this.lastVideoTime = this.video.currentTime;
      const face = tracksFace(this.mode) ? this.landmarker : undefined;
      const r = face?.detectForVideo(this.video, now);
      const shapes = r?.faceBlendshapes[0]?.categories;
      const blendshapes: Record<string, number> = {};
      for (const c of shapes ?? []) blendshapes[c.categoryName] = c.score;
      const m = r?.facialTransformationMatrixes[0];
      const hands = tracksHands(this.mode) ? this.hands : undefined;
      this.onFrame({
        t: now,
        face: (r?.faceLandmarks.length ?? 0) > 0,
        blendshapes,
        ...(m ? { matrix: Array.from(m.data) } : {}),
        ...(hands ? { hands: handsOf(hands.detectForVideo(this.video, now)) } : {}),
      });
      const done = performance.now();
      this.notBefore = done + (done - now);
      this.rateCount++;
      if (now - this.rateStart >= 1000) {
        this.rate = (this.rateCount * 1000) / (now - this.rateStart);
        this.rateCount = 0;
        this.rateStart = now;
      }
    }
    this.handle = requestAnimationFrame(this.loop);
  };
}

/**
 * Whether a model file is there. A development or preview server answers a
 * missing file with the app's own page, so a web page counts as missing.
 */
async function served(url: string): Promise<boolean> {
  const r = await fetch(url, { method: 'HEAD' }).catch(() => undefined);
  return !!r?.ok && !(r.headers.get('content-type') ?? '').includes('text/html');
}

/**
 * MediaPipe's hands as Mochi Studio's. MediaPipe labels handedness as if the
 * picture were mirrored (a selfie); the camera's picture is not, so its
 * "Left" is the subject's own right hand.
 */
function handsOf(r: import('@mediapipe/tasks-vision').HandLandmarkerResult): TrackedHand[] {
  return r.landmarks.map((points, i) => {
    const label = r.handedness[i]?.[0];
    const world = r.worldLandmarks[i];
    return {
      side: label?.categoryName === 'Left' ? 'right' : 'left',
      points: points.map((p) => [p.x, p.y, p.z] as const),
      ...(world ? { world: world.map((p) => [p.x, p.y, p.z] as const) } : {}),
      ...(label ? { score: label.score } : {}),
    };
  });
}

export async function listCameras(): Promise<MediaDeviceInfo[]> {
  const all = await navigator.mediaDevices.enumerateDevices();
  return all.filter((d) => d.kind === 'videoinput');
}

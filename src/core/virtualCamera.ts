/**
 * The virtual camera (docs/virtual-camera.md): the
 * avatar as a camera other apps open, "Mochi Studio Camera". Linux first,
 * through a v4l2loopback device; Windows and macOS later.
 *
 * Settings live app-wide (`AppSettings.virtualCamera`); the page turns them
 * into a configuration for the main process (`VirtualCameraConfig`), which
 * checks it again (`parseVirtualCameraConfig`) and reports its state
 * (`VirtualCameraState`).
 */

/** The name other apps list. */
export const CAMERA_NAME = 'Mochi Studio Camera';

/** The sizes the camera offers: 16:9, the first is the default. */
export const CAMERA_SIZES = [
  { width: 1280, height: 720 },
  { width: 1920, height: 1080 },
  { width: 960, height: 540 },
] as const;
export const CAMERA_RATES = [30, 60] as const;
/** The key color preset (a green that keys well). */
export const KEY_GREEN = '#00B140';

export type CameraBackground = { kind: 'stage' } | { kind: 'color'; color: string };

export interface VirtualCameraSettings {
  enabled: boolean;
  width: number;
  height: number;
  fps: number;
  /** Off by default: call apps mirror only the person's own preview. */
  mirror: boolean;
  /** The stage's background, or a solid color. Video apps show no transparency. */
  background: CameraBackground;
}

export const DEFAULT_VIRTUAL_CAMERA: VirtualCameraSettings = {
  enabled: false,
  width: 1280,
  height: 720,
  fps: 30,
  mirror: false,
  background: { kind: 'stage' },
};

const HEX = /^#[0-9a-fA-F]{6}$/;

/** Reads settings, keeping what is valid and the defaults for the rest. */
export function parseVirtualCamera(v: unknown): VirtualCameraSettings {
  const d = DEFAULT_VIRTUAL_CAMERA;
  if (typeof v !== 'object' || v === null) return structuredClone(d);
  const x = v as Record<string, unknown>;
  const size =
    CAMERA_SIZES.find((s) => s.width === x.width && s.height === x.height) ?? CAMERA_SIZES[0];
  const fps = CAMERA_RATES.find((r) => r === x.fps) ?? d.fps;
  const b = x.background as Record<string, unknown> | undefined;
  const background: CameraBackground =
    b && b.kind === 'color' && typeof b.color === 'string' && HEX.test(b.color)
      ? { kind: 'color', color: b.color.toUpperCase() }
      : { kind: 'stage' };
  return {
    enabled: x.enabled === true,
    width: size.width,
    height: size.height,
    fps,
    mirror: x.mirror === true,
    background,
  };
}

/** What the main process is asked to send. */
export interface VirtualCameraConfig {
  /** The app's own output view. */
  page: string;
  enabled: boolean;
  width: number;
  height: number;
  fps: number;
  mirror: boolean;
  /**
   * What shows through the page's transparent parts, as 0xRRGGBB: the key
   * color, or black under the stage's own background.
   */
  under: number;
  /** The page draws the stage's background (else it is transparent, over `under`). */
  stageBackground: boolean;
}

export function virtualCameraConfig(s: VirtualCameraSettings, page: string): VirtualCameraConfig {
  return {
    page,
    enabled: s.enabled,
    width: s.width,
    height: s.height,
    fps: s.fps,
    mirror: s.mirror,
    under: s.background.kind === 'color' ? parseInt(s.background.color.slice(1), 16) : 0,
    stageBackground: s.background.kind === 'stage',
  };
}

/** The camera's page: the output view, mirrored or not, transparent when a color goes under it. */
export function cameraPageUrl(c: VirtualCameraConfig): string {
  const u = new URL(c.page);
  u.searchParams.set('camera', '1');
  if (c.stageBackground) u.searchParams.delete('transparent');
  else u.searchParams.set('transparent', '1');
  if (c.mirror) u.searchParams.set('mirror', '1');
  else u.searchParams.delete('mirror');
  return u.href;
}

/** The main process's check of a configuration from the page. */
export function parseVirtualCameraConfig(
  v: unknown,
  origin: string,
): VirtualCameraConfig | undefined {
  if (typeof v !== 'object' || v === null) return undefined;
  const x = v as Record<string, unknown>;
  if (typeof x.page !== 'string') return undefined;
  let page: URL;
  try {
    page = new URL(x.page);
  } catch {
    return undefined;
  }
  if (page.origin !== origin || page.pathname !== '/app/output.html') return undefined;
  const size = CAMERA_SIZES.find((s) => s.width === x.width && s.height === x.height);
  const fps = CAMERA_RATES.find((r) => r === x.fps);
  const under = typeof x.under === 'number' && Number.isInteger(x.under) ? x.under : -1;
  if (!size || !fps || under < 0 || under > 0xffffff) return undefined;
  return {
    page: page.href,
    enabled: x.enabled === true,
    width: size.width,
    height: size.height,
    fps,
    mirror: x.mirror === true,
    under,
    stageBackground: x.stageBackground === true,
  };
}

/** What the main process reports. */
export interface VirtualCameraState {
  /** This platform and build can run the camera at all. */
  available: boolean;
  /** Why not, or what is missing (the module, the device). */
  problem?: string;
  /** What to do about it: the commands to run (Linux: install and load v4l2loopback). */
  setup?: string[];
  /** The device frames go to (Linux: /dev/videoN). */
  device?: string;
  /** Sending now. */
  active: boolean;
  width: number;
  height: number;
  fps: number;
  /** Frames written since it started. */
  frames: number;
  error?: string;
}

/** The line that creates the camera's device (docs/virtual-camera.md, Linux). */
export const MODPROBE_LINE = `sudo modprobe v4l2loopback devices=1 video_nr=10 card_label="${CAMERA_NAME}" exclusive_caps=1`;

/** What to install and run when the device is missing, per distribution family. */
export const LINUX_SETUP = [
  'Debian or Ubuntu: sudo apt install v4l2loopback-dkms',
  'Fedora: sudo dnf install v4l2loopback (from RPM Fusion)',
  'Arch: sudo pacman -S v4l2loopback-dkms',
  `Then: ${MODPROBE_LINE}`,
];

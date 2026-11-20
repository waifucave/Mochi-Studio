/**
 * Camera and microphone failures as messages a person can act on: what
 * happened, and what to do about it. Browsers report `getUserMedia`
 * failures as DOMException names; Mochi2D reports the microphone's as a
 * `LiveAudioError` code.
 */

export interface MediaContext {
  /** The desktop app (Electron) rather than a browser. */
  desktop: boolean;
  /** The page is a secure context (https or localhost). */
  secure: boolean;
  platform: 'mac' | 'windows' | 'other';
}

type Device = 'camera' | 'microphone';

function denied(device: Device, c: MediaContext): string {
  const Dev = device === 'camera' ? 'Camera' : 'Microphone';
  if (c.desktop)
    return c.platform === 'mac'
      ? `${Dev} access is off for Mochi Studio. Turn it on in System Settings → Privacy & Security → ${Dev}, then try again.`
      : c.platform === 'windows'
        ? `${Dev} access is off. Turn it on in Settings → Privacy & security → ${Dev} (“Let desktop apps access your ${device}”), then try again.`
        : `${Dev} access was refused. Check that no other setting blocks the ${device}, then try again.`;
  return `${Dev} access was blocked. Allow it in the site settings (the icon at the left of the address bar), then try again.${
    c.platform === 'mac'
      ? ` On a Mac, the browser itself also needs ${device} access in System Settings → Privacy & Security → ${Dev}.`
      : ''
  }`;
}

function insecure(device: Device): string {
  return `The ${device} only works on a secure page: open Mochi Studio at http://localhost (npm run dev or npm run preview) or over https.`;
}

/** A message for a failure to start the camera. */
export function cameraErrorMessage(e: unknown, c: MediaContext): string {
  const name = (e as { name?: string })?.name ?? '';
  const message = (e as { message?: string })?.message ?? String(e);
  if (!c.secure) return insecure('camera');
  switch (name) {
    case 'NotAllowedError':
    case 'SecurityError':
      return denied('camera', c);
    case 'NotFoundError':
    case 'OverconstrainedError':
      return 'No camera was found. Connect one (or check that it is switched on), then try again.';
    case 'NotReadableError':
    case 'AbortError':
      return 'The camera could not be opened: another app may be using it (a video call, or OBS’s own Video Capture Device of the same camera). Close that, then try again.';
    default:
      return message;
  }
}

/** A message for a failure to start the microphone (a Mochi2D LiveAudioError or a DOMException). */
export function microphoneErrorMessage(e: unknown, c: MediaContext): string {
  const code = (e as { code?: string })?.code ?? '';
  const name = (e as { name?: string })?.name ?? '';
  const message = (e as { message?: string })?.message ?? String(e);
  if (code === 'insecure-context' || !c.secure) return insecure('microphone');
  if (code === 'denied' || code === 'blocked' || name === 'NotAllowedError')
    return denied('microphone', c);
  if (code === 'no-device' || name === 'NotFoundError' || name === 'OverconstrainedError')
    return 'No microphone was found (or the chosen one is gone). Connect one or choose another, then try again.';
  if (code === 'busy' || name === 'NotReadableError')
    return 'The microphone could not be opened: another app may be using it. Close that, then try again.';
  if (code === 'no-lip-sync')
    return 'This model has no mouth parameter for lip sync, so the microphone cannot move it.';
  return message;
}

/** The context of this page. */
export function mediaContext(desktop: boolean): MediaContext {
  const g = globalThis as { isSecureContext?: boolean; navigator?: { userAgent?: string } };
  const ua = g.navigator?.userAgent ?? '';
  return {
    desktop,
    secure: g.isSecureContext !== false,
    platform: /Mac OS X|Macintosh/.test(ua) ? 'mac' : /Windows/.test(ua) ? 'windows' : 'other',
  };
}

/**
 * The phone tracker's page (phone.html), served on the local
 * network by the bridge (bridge/src/phone.ts). MediaPipe tracks the face
 * here, in the phone's browser, with Mochi Studio's own tracker; only the
 * tracking values (blendshapes and the head's matrix) go to the computer.
 *
 * «Connect to PC»: the first time, with the pairing code Mochi Studio
 * shows; after that the phone's token (kept in this browser) is enough. If
 * the link drops, the page reconnects by itself.
 */
import type { BridgeToPhone, PhoneToBridge } from '../core/phoneProtocol';
import { phoneName } from '../core/phoneProtocol';
import { FaceTracker } from './faceTracker';

const TOKEN_KEY = 'mochi-studio-phone-token';
const RETRY_MS = 2000;

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;
const button = $<HTMLButtonElement>('connect');
const status = $('status');
const pairBox = $('pair');
const codeInput = $<HTMLInputElement>('code');
const faceLine = $('face');

const storage = {
  get(): string | undefined {
    try {
      return localStorage.getItem(TOKEN_KEY) ?? undefined;
    } catch {
      return undefined;
    }
  },
  set(token: string | undefined): void {
    try {
      if (token) localStorage.setItem(TOKEN_KEY, token);
      else localStorage.removeItem(TOKEN_KEY);
    } catch {
      /* private browsing: pair again next time */
    }
  },
};

let ws: WebSocket | undefined;
let wanted = false;
let linked = false;
let retry: ReturnType<typeof setTimeout> | undefined;
let tracker: FaceTracker | undefined;
let wake: { release(): Promise<void> } | undefined;
let lastFace: boolean | undefined;
let frames = 0;

function say(text: string, kind: '' | 'ok' | 'error' = ''): void {
  status.textContent = text;
  status.dataset.kind = kind;
}

function send(m: PhoneToBridge): void {
  if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(m));
}

function connect(): void {
  clearTimeout(retry);
  wanted = true;
  linked = false;
  button.textContent = 'Disconnect';
  say('Connecting…');
  const socket = new WebSocket(`wss://${location.host}/track`);
  ws = socket;
  socket.onopen = () => {
    const token = storage.get();
    send({ type: 'hello', ...(token ? { token } : {}), name: phoneName(navigator.userAgent) });
  };
  socket.onmessage = (e) => {
    let m: BridgeToPhone;
    try {
      m = JSON.parse(String(e.data)) as BridgeToPhone;
    } catch {
      return;
    }
    onMessage(m);
  };
  socket.onclose = (e) => {
    if (ws !== socket) return;
    linked = false;
    if (e.code === 4401) {
      // Revoked in Mochi Studio: pair again.
      storage.set(undefined);
      wanted = false;
      button.textContent = 'Connect to PC';
      pairBox.hidden = false;
      say('Mochi Studio revoked this phone. Type a new pairing code to connect again.', 'error');
      return;
    }
    if (!wanted) return;
    say('The connection dropped. Reconnecting…', 'error');
    retry = setTimeout(connect, RETRY_MS);
  };
}

function disconnect(): void {
  wanted = false;
  linked = false;
  clearTimeout(retry);
  ws?.close();
  ws = undefined;
  tracker?.stop();
  void wake?.release().catch(() => undefined);
  wake = undefined;
  button.textContent = 'Connect to PC';
  say('Disconnected.');
  faceLine.textContent = '';
}

function onMessage(m: BridgeToPhone): void {
  switch (m.type) {
    case 'pair_needed':
      pairBox.hidden = false;
      if (/^\d{6}$/.test(codeInput.value)) return pair();
      say('Type the pairing code that Mochi Studio shows, then press Connect to PC.');
      button.textContent = 'Connect to PC';
      codeInput.focus();
      return;
    case 'pair_failed':
      say(m.message, 'error');
      button.textContent = 'Connect to PC';
      return;
    case 'paired':
      storage.set(m.token);
      return linkedUp(m.name);
    case 'welcome':
      return linkedUp(m.name);
  }
}

function pair(): void {
  const code = codeInput.value.replace(/\D/g, '');
  if (code.length !== 6) return say('The pairing code has six digits.', 'error');
  say('Pairing…');
  send({ type: 'pair', code, name: phoneName(navigator.userAgent) });
}

function linkedUp(name: string): void {
  linked = true;
  pairBox.hidden = true;
  codeInput.value = '';
  button.textContent = 'Disconnect';
  say(`Connected to Mochi Studio (as “${name}”).`, 'ok');
  void startTracking();
  void keepAwake();
}

async function startTracking(): Promise<void> {
  if (tracker?.active) return;
  tracker ??= new FaceTracker((f) => {
    if (!linked) return;
    frames++;
    send({
      type: 'frame',
      face: f.face,
      blendshapes: f.blendshapes,
      ...(f.matrix ? { matrix: f.matrix } : {}),
    });
    if (f.face !== lastFace) {
      lastFace = f.face;
      faceLine.textContent = f.face ? 'Face found' : 'No face: look at the camera';
    }
  });
  tracker.mode = 'face';
  try {
    await tracker.start(undefined, { facingMode: 'user' });
  } catch (e) {
    const name = (e as { name?: string }).name;
    say(
      name === 'NotAllowedError'
        ? 'The camera is blocked: allow it for this page in the browser’s settings, then reload.'
        : `The camera could not start: ${(e as Error).message}`,
      'error',
    );
  }
}

/** Keeps the screen on while tracking (where the browser can). */
async function keepAwake(): Promise<void> {
  const nav = navigator as Navigator & {
    wakeLock?: { request(type: 'screen'): Promise<{ release(): Promise<void> }> };
  };
  try {
    wake = await nav.wakeLock?.request('screen');
  } catch {
    /* not allowed now (battery saver, for one) */
  }
}

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && linked && !wake) void keepAwake();
});

button.addEventListener('click', () => {
  if (!pairBox.hidden && ws?.readyState === WebSocket.OPEN && !linked) return pair();
  if (wanted) return disconnect();
  connect();
});
codeInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') button.click();
});

// The rate, for the person.
setInterval(() => {
  if (linked && tracker?.active) say(`Connected to Mochi Studio · ${frames} frames a second`, 'ok');
  frames = 0;
}, 1000);

// For tests: the state of the link.
(window as unknown as { mochiPhone: object }).mochiPhone = {
  get linked() {
    return linked;
  },
  get tracking() {
    return !!tracker?.active;
  },
};

// An approved phone connects at once.
if (storage.get()) connect();

/**
 * What the desktop app adds to its pages:
 *
 * - a native folder dialog: the page gets the folder's file list and an id,
 *   and reads the files from the app's bridge (`/disk/<id>/…`), which views
 *   then use too, with no upload;
 * - recent model folders, which the page may reopen (only those);
 * - hotkeys that work while another app has focus;
 * - the pointer anywhere on the screen, for the mouse inputs.
 */
import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('mochiDesktop', {
  openFolder: (): Promise<unknown> => ipcRenderer.invoke('mochi:open-folder'),
  openZip: (): Promise<unknown> => ipcRenderer.invoke('mochi:open-zip'),
  recentModels: (): Promise<unknown> => ipcRenderer.invoke('mochi:recent-models'),
  openRecent: (dir: string): Promise<unknown> => ipcRenderer.invoke('mochi:open-recent', dir),
  forgetRecent: (dir: string): Promise<unknown> => ipcRenderer.invoke('mochi:forget-recent', dir),
  setGlobalHotkeys: (accelerators: string[]): Promise<Record<string, boolean>> =>
    ipcRenderer.invoke('mochi:global-hotkeys', accelerators),
  onGlobalHotkey: (fn: (accelerator: string) => void): void => {
    ipcRenderer.on('mochi:global-hotkey', (_e, a: string) => fn(a));
  },
  watchPointer: (fn: (p: unknown) => void): void => {
    ipcRenderer.on('mochi:pointer', (_e, p: unknown) => fn(p));
    void ipcRenderer.invoke('mochi:pointer-watch', true);
  },
  listScreens: (): Promise<unknown> => ipcRenderer.invoke('mochi:screens'),
  captureSources: (): Promise<unknown> => ipcRenderer.invoke('mochi:capture-sources'),
  startWebItem: (o: unknown): Promise<unknown> => ipcRenderer.invoke('mochi:web-item-start', o),
  stopWebItem: (id: string): Promise<unknown> => ipcRenderer.invoke('mochi:web-item-stop', id),
  onWebItemFrame: (fn: (id: string, frame: unknown) => void): void => {
    ipcRenderer.on('mochi:web-item-frame', (_e, id: string, frame: unknown) => fn(id, frame));
  },
  setPointerScreen: (id: number | null): Promise<unknown> =>
    ipcRenderer.invoke('mochi:pointer-screen', id),
  spoutConfigure: (c: unknown): Promise<unknown> => ipcRenderer.invoke('mochi:spout-configure', c),
  spoutState: (): Promise<unknown> => ipcRenderer.invoke('mochi:spout-state'),
  virtualCameraConfigure: (c: unknown): Promise<unknown> =>
    ipcRenderer.invoke('mochi:vcam-configure', c),
  virtualCameraState: (): Promise<unknown> => ipcRenderer.invoke('mochi:vcam-state'),
  onMainError: (fn: (text: string) => void): void => {
    ipcRenderer.on('mochi:main-error', (_e, text: unknown) => fn(String(text)));
  },
});

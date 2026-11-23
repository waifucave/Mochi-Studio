/**
 * The Camera tab's virtual-camera section, after Spout2: the
 * avatar as "Mochi Studio Camera" for call and streaming apps. On, Mirror,
 * the size and rate, and the background; a status line; on Windows, Install
 * and Uninstall; and on Linux, while the device is missing, what to install
 * and run. Desktop app only.
 */
import { rateText } from '../core/frameGovernor';
import {
  CAMERA_NAME,
  CAMERA_RATES,
  CAMERA_SIZES,
  KEY_GREEN,
  type CameraInstallState,
  type VirtualCameraSettings,
} from '../core/virtualCamera';
import { h } from './dom';
import type { Studio } from './studio';

export function virtualCameraSection(
  studio: Studio,
  run: (name: string, args: unknown) => void,
): HTMLElement {
  const box = h('section', { class: 'vcam', id: 'vcam' });
  const st = studio.virtualCameraStatus();
  const s = st.settings;
  box.append(h('h4', {}, 'Virtual camera'));
  if (!st.available) {
    box.append(
      h(
        'p',
        { class: 'hint', id: 'vcam-note' },
        st.problem ?? 'The virtual camera is available in the desktop app.',
      ),
    );
    return box;
  }
  const set = (args: Record<string, unknown>) => run('set_virtual_camera', args);
  const status = (): string => {
    if (!s.enabled) return 'Off.';
    if (st.error) return `Problem: ${st.error}`;
    if (st.problem) return st.problem;
    if (!st.active) return 'Starting…';
    // The camera writes at its rate; while held, its picture changes fewer times a second.
    if (st.heldFps)
      return `Sending ${st.width} × ${st.height} to ${st.device}; the picture changes ${rateText(st.heldFps)} times a second: this computer can't keep up at this size.`;
    return `Sending ${st.width} × ${st.height} at ${st.fps} frames a second to ${st.device}.`;
  };
  const sizeKey = (z: { width: number; height: number }) => `${z.width}x${z.height}`;
  box.append(
    h(
      'p',
      { class: 'hint' },
      `Call and streaming apps (Discord, Zoom, Meet in a browser, OBS) list the avatar as a camera named “${CAMERA_NAME}”. Video apps show no transparency, so the camera has a background.`,
    ),
    h(
      'label',
      { class: 'switch' },
      h('input', {
        type: 'checkbox',
        id: 'vcam-on',
        checked: s.enabled,
        onchange: (e: Event) => set({ enabled: (e.target as HTMLInputElement).checked }),
      }),
      ' Send as a camera',
    ),
    h(
      'label',
      {},
      h('input', {
        type: 'checkbox',
        id: 'vcam-mirror',
        checked: s.mirror,
        onchange: (e: Event) => set({ mirror: (e.target as HTMLInputElement).checked }),
      }),
      ' Mirror',
      h('span', { class: 'hint' }, ' (call apps already mirror your own preview)'),
    ),
    h(
      'div',
      { class: 'row' },
      h(
        'label',
        {},
        'Size ',
        h(
          'select',
          {
            id: 'vcam-size',
            onchange: (e: Event) => {
              const [w, hh] = (e.target as HTMLSelectElement).value.split('x').map(Number);
              set({ width: w, height: hh });
            },
          },
          ...CAMERA_SIZES.map((z) =>
            h(
              'option',
              { value: sizeKey(z), selected: sizeKey(z) === sizeKey(s) },
              `${z.width} × ${z.height}`,
            ),
          ),
        ),
      ),
      h(
        'label',
        {},
        ' Rate ',
        h(
          'select',
          {
            id: 'vcam-fps',
            onchange: (e: Event) => set({ fps: Number((e.target as HTMLSelectElement).value) }),
          },
          ...CAMERA_RATES.map((r) =>
            h('option', { value: r, selected: r === s.fps }, `${r} frames a second`),
          ),
        ),
      ),
    ),
    backgroundRow(s, set),
    h('p', { class: 'hint vcam-status', id: 'vcam-status' }, status()),
  );
  if (st.install) box.append(installRow(studio, st.install));
  if (st.setup?.length)
    box.append(
      h('p', { class: 'hint' }, 'To make the camera, install v4l2loopback and load it once:'),
      h('pre', { class: 'mono', id: 'vcam-setup' }, st.setup.join('\n')),
      h(
        'p',
        { class: 'hint' },
        'Mochi Studio finds the camera a moment after it is loaded. With Secure Boot, your distribution asks you to sign the module when it installs.',
      ),
    );
  return box;
}

function backgroundRow(
  s: VirtualCameraSettings,
  set: (args: Record<string, unknown>) => void,
): HTMLElement {
  const color = s.background.kind === 'color' ? s.background.color : KEY_GREEN;
  return h(
    'div',
    { class: 'row' },
    'Background ',
    h(
      'label',
      {},
      h('input', {
        type: 'radio',
        name: 'vcam-bg',
        id: 'vcam-bg-stage',
        checked: s.background.kind === 'stage',
        onchange: () => set({ background: 'stage' }),
      }),
      ' The stage’s',
    ),
    h(
      'label',
      {},
      h('input', {
        type: 'radio',
        name: 'vcam-bg',
        id: 'vcam-bg-color',
        checked: s.background.kind === 'color',
        onchange: () => set({ background: color }),
      }),
      ' A color ',
    ),
    h('input', {
      type: 'color',
      id: 'vcam-color',
      value: color.toLowerCase(),
      'aria-label': 'Camera background color',
      onchange: (e: Event) => set({ background: (e.target as HTMLInputElement).value }),
    }),
    h('button', { id: 'vcam-green', onclick: () => set({ background: KEY_GREEN }) }, 'Key green'),
  );
}

/** The person's choice for the next Install, kept while the row is redrawn. */
let olderAppsChoice: boolean | undefined;

/** Windows and macOS: the camera other apps list is installed once, and can be removed. */
function installRow(studio: Studio, i: CameraInstallState): HTMLElement {
  // Windows 11: the second camera, for apps that only use DirectShow, on request.
  const older =
    i.olderApps === undefined
      ? undefined
      : h('input', {
          type: 'checkbox',
          id: 'vcam-older-apps',
          checked: olderAppsChoice ?? i.olderApps,
          onchange: (e: Event) => (olderAppsChoice = (e.target as HTMLInputElement).checked),
        });
  const act = (action: 'install' | 'uninstall') =>
    void studio.installVirtualCamera(
      action,
      older ? { olderApps: (older as HTMLInputElement).checked } : undefined,
    );
  return h(
    'div',
    { class: 'vcam-install', id: 'vcam-install' },
    h(
      'div',
      { class: 'row' },
      h(
        'strong',
        { id: 'vcam-installed', 'data-installed': String(i.installed) },
        i.busy ? 'Working…' : i.installed ? 'Installed' : 'Not installed',
      ),
      h(
        'button',
        { id: 'vcam-install-button', disabled: !!i.busy, onclick: () => act('install') },
        i.installed ? 'Install again' : 'Install',
      ),
      i.installed
        ? h(
            'button',
            { id: 'vcam-uninstall-button', disabled: !!i.busy, onclick: () => act('uninstall') },
            'Uninstall',
          )
        : '',
    ),
    older
      ? h(
          'label',
          { class: 'row' },
          older,
          ' Also for older apps (a second camera, for apps that use only DirectShow, and 32-bit apps). Takes effect at Install.',
        )
      : '',
    i.detail ? h('p', { class: 'hint' }, i.detail) : '',
    i.error
      ? h('p', { class: 'hint error', role: 'alert', id: 'vcam-install-error' }, i.error)
      : '',
  );
}

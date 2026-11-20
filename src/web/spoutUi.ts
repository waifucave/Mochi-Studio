/**
 * The Camera tab's Spout2 section, next to the output view's
 * address: up to four outputs, each sent as its own Spout2 sender
 * (MochiStudio, MochiStudio2, …), on or off, mirrored or not, at the
 * stage's size or a fixed one. Desktop app on Windows; elsewhere a note.
 */
import {
  SPOUT_MAX_OUTPUTS,
  SPOUT_MAX_SIZE,
  SPOUT_MIN_SIZE,
  spoutSenderName,
  spoutSize,
  type SpoutOutputSetting,
  type SpoutOutputState,
} from '../core/spout';
import { h } from './dom';
import type { Studio } from './studio';

const statusText = (st: SpoutOutputState | undefined, on: boolean): string => {
  if (!on) return 'Off.';
  if (!st) return 'Starting…';
  if (st.error) return `Problem: ${st.error}`;
  if (!st.active) return `Starting at ${st.width} × ${st.height}…`;
  const path = st.path === 'gpu' ? 'on the graphics card' : 'through memory';
  return `Sending ${st.width} × ${st.height}${st.mirror ? ', mirrored' : ''}, ${path}.`;
};

export function spoutSection(
  studio: Studio,
  run: (name: string, args: unknown) => void,
): HTMLElement {
  const box = h('section', { class: 'spout', id: 'spout' });
  const status = studio.spoutStatus();
  const save = (outputs: SpoutOutputSetting[]): void =>
    run('set_spout', {
      outputs: outputs.map((o) => ({
        enabled: o.enabled,
        mirror: o.mirror,
        ...(o.size ? { width: o.size.width, height: o.size.height } : {}),
      })),
    });
  const intro = h(
    'p',
    { class: 'hint' },
    'Spout2 sends the avatar, without the rest of the window, on a transparent background to OBS and other programs on this computer, with almost no cost. In OBS: the Spout2 plugin, a Spout2 source, and the composite mode set to premultiplied alpha.',
  );
  if (!studio.spoutSupported || !status.available) {
    box.append(
      h('h4', {}, 'Spout2'),
      h(
        'p',
        { class: 'hint', id: 'spout-note' },
        status.problem ?? 'Spout2 is available in the desktop app on Windows.',
      ),
    );
    return box;
  }
  const outputs = status.settings.outputs;
  const stage = studio.runtime.pixelSize();
  const rows = outputs.map((o, i) => {
    const name = spoutSenderName(i);
    const st = status.outputs.find((x) => x.name === name);
    const set = (patch: Partial<SpoutOutputSetting>): void => {
      const next = outputs.map((x) => ({ ...x }));
      next[i] = { ...next[i]!, ...patch };
      if ('size' in patch && !patch.size) delete next[i]!.size;
      save(next);
    };
    const size = spoutSize(o, stage);
    const num = (id: string, v: number, aria: string, key: 'width' | 'height') =>
      h('input', {
        type: 'number',
        id,
        min: SPOUT_MIN_SIZE,
        max: SPOUT_MAX_SIZE,
        value: v,
        'aria-label': aria,
        disabled: !o.size,
        onchange: (e: Event) => {
          const val = Number((e.target as HTMLInputElement).value);
          set({ size: { ...size, [key]: val } });
        },
      });
    return h(
      'div',
      { class: 'spout-output', 'data-name': name },
      h(
        'label',
        { class: 'switch' },
        h('input', {
          type: 'checkbox',
          id: `spout-on-${i}`,
          checked: o.enabled,
          onchange: (e: Event) => set({ enabled: (e.target as HTMLInputElement).checked }),
        }),
        ` Send as `,
        h('strong', { class: 'mono' }, name),
      ),
      h(
        'label',
        {},
        h('input', {
          type: 'checkbox',
          id: `spout-mirror-${i}`,
          checked: o.mirror,
          onchange: (e: Event) => set({ mirror: (e.target as HTMLInputElement).checked }),
        }),
        ' Mirror',
      ),
      h(
        'div',
        { class: 'row' },
        h(
          'label',
          {},
          h('input', {
            type: 'checkbox',
            id: `spout-fixed-${i}`,
            checked: !!o.size,
            onchange: (e: Event) =>
              set({ size: (e.target as HTMLInputElement).checked ? size : undefined }),
          }),
          ' Fixed size',
        ),
        num(`spout-w-${i}`, size.width, `${name} width`, 'width'),
        '×',
        num(`spout-h-${i}`, size.height, `${name} height`, 'height'),
        o.size ? '' : h('span', { class: 'hint' }, ' (the stage’s)'),
      ),
      h('p', { class: 'hint spout-status', id: `spout-status-${i}` }, statusText(st, o.enabled)),
      i > 0
        ? h(
            'button',
            {
              class: 'spout-remove',
              onclick: () => save(outputs.filter((_, j) => j !== i)),
            },
            `Remove ${name}`,
          )
        : '',
    );
  });
  box.append(
    h('h4', {}, 'Spout2'),
    intro,
    ...rows,
    outputs.length < SPOUT_MAX_OUTPUTS
      ? h(
          'button',
          {
            id: 'spout-add',
            onclick: () => save([...outputs, { enabled: true, mirror: false }]),
          },
          'Add an output',
        )
      : '',
    h(
      'p',
      { class: 'hint' },
      'On a laptop with two graphics chips, run Mochi Studio and OBS on the same one (the dedicated one), or OBS shows black.',
    ),
  );
  return box;
}

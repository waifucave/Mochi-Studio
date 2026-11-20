/**
 * The Model tab's light strength per art mesh: how much the
 * light from the screen affects each one, 0 to 1 (1 by default), so that
 * eyes, say, "glow in the dark". Imported from VTube Studio settings
 * (`ArtMeshSceneLightingMultipliers`) and saved with the model.
 */
import { h } from './dom';
import type { Studio } from './studio';

export function lightStrengthSection(studio: Studio): HTMLElement {
  const strengths = studio.settings?.lightStrengths ?? {};
  const ids = studio.model ? studio.runtime.artMeshIds() : [];
  const save = (next: Record<string, number>): void =>
    studio.updateSettings({ lightStrengths: next });
  const set = (id: string, v: number): void => {
    const next = { ...(studio.settings?.lightStrengths ?? {}) };
    if (v >= 1) delete next[id];
    else next[id] = Math.round(Math.max(0, v) * 100) / 100;
    save(next);
  };
  const row = (id: string, v: number): HTMLElement => {
    const out = h('output', {}, v.toFixed(2));
    return h(
      'div',
      { class: 'row light-strength', 'data-mesh': id },
      h('span', { class: 'mono' }, id),
      h('input', {
        type: 'range',
        min: 0,
        max: 1,
        step: 0.05,
        value: v,
        'aria-label': `Light on ${id}`,
        oninput: (e: Event) => {
          const x = Number((e.target as HTMLInputElement).value);
          out.textContent = x.toFixed(2);
        },
        onchange: (e: Event) => set(id, Number((e.target as HTMLInputElement).value)),
      }),
      out,
      h(
        'button',
        { class: 'icon', title: 'Back to 1 (all of the light)', onclick: () => set(id, 1) },
        '✕',
      ),
    );
  };
  const pick = h('input', {
    list: 'dl-light-meshes',
    id: 'light-mesh',
    placeholder: 'Art mesh ID',
    'aria-label': 'Art mesh',
  }) as HTMLInputElement;
  return h(
    'details',
    { class: 'light-strengths', id: 'light-strengths' },
    h('summary', {}, `Light strength per art mesh (${Object.keys(strengths).length})`),
    h(
      'p',
      { class: 'hint' },
      'How much the light from the screen (Camera tab) affects an art mesh: 1, the default, takes all of it, 0 none, so a mesh such as the eyes keeps its own colors.',
    ),
    h('datalist', { id: 'dl-light-meshes' }, ...ids.map((id) => h('option', { value: id }))),
    ...Object.entries(strengths).map(([id, v]) => row(id, v)),
    h(
      'div',
      { class: 'row' },
      pick,
      h(
        'button',
        {
          id: 'light-mesh-add',
          onclick: () => {
            const id = pick.value.trim();
            if (id) set(id, 0.5);
          },
        },
        'Add at 0.5',
      ),
    ),
  );
}

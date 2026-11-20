/**
 * The Model tab's physics section: the
 * physics switch, the overall strength, the wind, and a multiplier from 0 to 2
 * per physics group, named from the model's physics file. Saved per model.
 */
import {
  DEFAULT_PHYSICS_TUNING,
  PHYSICS_RATES,
  type PhysicsRate,
  type PhysicsTuning,
} from '../core/physicsTuning';
import { h, select } from './dom';
import type { Studio } from './studio';

/** The note shown while a plugin overrides the physics (kept up to date by the studio's event). */
let overrideNote: HTMLElement | undefined;

export function updatePhysicsOverrideNote(by: string | undefined): void {
  if (!overrideNote) return;
  overrideNote.hidden = by === undefined;
  overrideNote.textContent = by
    ? `The plugin “${by}” is changing the physics for a moment. Your settings come back when it stops.`
    : '';
}

export function physicsSection(studio: Studio): HTMLElement {
  const s = studio.settings;
  const t: PhysicsTuning = s?.physicsTuning ?? DEFAULT_PHYSICS_TUNING;
  const groups = studio.physicsGroups();
  const save = (patch: Partial<PhysicsTuning>): void => {
    const now = studio.settings?.physicsTuning ?? DEFAULT_PHYSICS_TUNING;
    studio.updateSettings({ physicsTuning: { ...now, ...patch } });
  };
  const value = (e: Event): number => Number((e.target as HTMLInputElement).value);

  const slider = (
    id: string,
    label: string,
    v: number,
    hint: string,
    set: (v: number) => void,
  ): HTMLElement => {
    const out = h('output', { for: id }, String(v));
    return h(
      'label',
      { class: 'physics-slider' },
      label,
      h('input', {
        type: 'range',
        id,
        min: 0,
        max: 100,
        step: 1,
        value: v,
        title: hint,
        oninput: (e: Event) => {
          out.textContent = String(value(e));
          set(value(e));
        },
      }),
      out,
    );
  };

  /** A group's multiplier, 0 to 2: its strength, or its share of the wind (Mochi2D 0.13.0). */
  const groupRow = (g: { id: string; name: string }, kind: 'strength' | 'wind'): HTMLElement => {
    const key = kind === 'strength' ? 'groups' : 'windGroups';
    const k = (kind === 'strength' ? t.groups : t.windGroups)?.[g.id] ?? 1;
    const out = h('output', {}, `×${k.toFixed(2)}`);
    return h(
      'label',
      { class: kind === 'strength' ? 'physics-group-row' : 'physics-group-wind-row' },
      g.name || g.id,
      h('input', {
        type: 'range',
        class: kind === 'strength' ? 'physics-group' : 'physics-group-wind',
        'data-group': g.id,
        min: 0,
        max: 2,
        step: 0.05,
        value: k,
        title:
          kind === 'strength'
            ? `${g.id}: 0 holds it still, 1 as the model was made, 2 twice as much`
            : `${g.id}: 0 shields it from the wind, 1 as the rest, 2 twice as much`,
        'aria-label': `${kind === 'strength' ? 'Strength' : 'Wind'} of ${g.name || g.id}`,
        oninput: (e: Event) => {
          const v = Math.round(value(e) * 100) / 100;
          out.textContent = `×${v.toFixed(2)}`;
          const now = { ...(studio.settings?.physicsTuning[key] ?? {}) };
          if (v === 1) delete now[g.id];
          else now[g.id] = v;
          save({ [key]: now });
        },
      }),
      out,
    );
  };

  // The physics rate: the file's own (the default), one step a frame, or fixed.
  const fileRate = studio.runtime.physicsRate().file;
  const rateLabel = (r: PhysicsRate): string =>
    r === 0 ? 'Same as the app (one step a frame)' : `${r} steps a second`;
  const rate = select(
    [
      [
        'file',
        `The model’s own (${fileRate > 0 ? `${fileRate} steps a second` : 'one step a frame'})`,
      ],
      ...PHYSICS_RATES.map((r) => [String(r), rateLabel(r)] as const),
    ] as const,
    t.rate === undefined ? 'file' : String(t.rate),
    (v) => {
      const now = studio.settings?.physicsTuning ?? DEFAULT_PHYSICS_TUNING;
      const { rate: _old, ...rest } = now;
      studio.updateSettings({
        physicsTuning: v === 'file' ? rest : { ...rest, rate: Number(v) as PhysicsRate },
      });
    },
    'Physics rate',
  );
  rate.id = 'physics-rate';
  rate.title =
    'How often the physics is worked out. Higher rates swing more smoothly and cost a little more time each frame.';

  overrideNote = h('p', { class: 'hint', id: 'physics-override', hidden: true });
  const section = h(
    'div',
    { class: 'physics', id: 'physics-settings' },
    h(
      'label',
      { class: 'check' },
      h('input', {
        type: 'checkbox',
        id: 'model-physics',
        checked: s?.physics ?? true,
        onchange: (e: Event) =>
          studio.updateSettings({ physics: (e.target as HTMLInputElement).checked }),
      }),
      'Physics (hair, clothes and accessories swing)',
    ),
    slider(
      'physics-strength',
      'Strength',
      t.strength,
      '50 is the model as it was made; 0 holds everything still, 100 doubles the swing',
      (v) => save({ strength: v }),
    ),
    slider(
      'physics-wind',
      'Wind',
      t.wind,
      'Gusts of wind that drift slowly from side to side; at 100 the strongest are as strong as gravity',
      (v) => save({ wind: v }),
    ),
    h('label', { class: 'physics-rate' }, 'Rate', rate),
    groups.length
      ? h(
          'details',
          { class: 'advanced physics-groups' },
          h('summary', {}, `Physics groups (${groups.length})`),
          h(
            'p',
            { class: 'hint' },
            'How much each group of the model’s physics moves, times the strength above.',
          ),
          ...groups.map((g) => groupRow(g, 'strength')),
          h('p', { class: 'hint' }, 'How much of the wind each group feels, times the wind above.'),
          ...groups.map((g) => groupRow(g, 'wind')),
        )
      : '',
    h(
      'button',
      {
        id: 'physics-reset',
        title:
          'Strength 50, no wind, every group at ×1 for strength and wind, the model’s own rate',
        onclick: () => {
          studio.updateSettings({ physicsTuning: { ...DEFAULT_PHYSICS_TUNING, groups: {} } });
          section.replaceWith(physicsSection(studio));
        },
      },
      'Reset physics',
    ),
    overrideNote,
  );
  const by = studio.physicsOverrides.controller(performance.now())?.name;
  updatePhysicsOverrideNote(by);
  return section;
}

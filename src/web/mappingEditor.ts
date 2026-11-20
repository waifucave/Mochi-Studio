import {
  defaultRules,
  makeRule,
  ruleSmoother,
  type MappingRule,
  type SmootherKind,
} from '../core/mapping';
import { parameterSource } from '../core/paramSources';
import { allInputs, inputInfo, readInput } from '../core/tracking';
import { h, numberInput } from './dom';
import type { Studio } from './studio';

/** The mapping editor: any tracking input to any model parameter. */
export function mappingEditor(studio: Studio): { el: HTMLElement; refresh(): void; live(): void } {
  const el = h('div', { class: 'mapping' });
  const liveCells = new Map<
    string,
    { inp: HTMLElement; out: HTMLElement; bar: HTMLElement; source: HTMLElement }
  >();

  const update = (id: string, patch: Partial<MappingRule>): void => {
    const s = studio.settings;
    if (!s) return;
    void studio
      .run('set_mapping', { rules: s.mapping.map((r) => (r.id === id ? { ...r, ...patch } : r)) })
      .catch(() => undefined);
  };

  function refresh(): void {
    el.replaceChildren();
    liveCells.clear();
    const s = studio.settings;
    if (!s || !studio.info) {
      el.append(h('p', { class: 'hint' }, 'Load a model to edit its mapping.'));
      return;
    }
    const inputs = allInputs();
    const params = studio.info.parameters;
    const inputList = h(
      'datalist',
      { id: 'dl-inputs' },
      ...inputs.map((i) => h('option', { value: i.id }, i.label)),
    );
    const paramList = h(
      'datalist',
      { id: 'dl-params' },
      ...params.map((p) => h('option', { value: p.id }, p.name)),
    );
    const rows = s.mapping.map((r) => {
      const inp = h('span', { class: 'live' });
      const out = h('span', { class: 'live' });
      const bar = h('span', { class: 'bar' });
      const source = h('p', { class: 'hint source', 'data-source': '' });
      liveCells.set(r.id, { inp, out, bar, source });
      const unknownOut = !params.some((p) => p.id === r.output);
      const redirects = studio.trackingRedirects;
      const driver = r.enabled ? redirects[r.output]?.from : undefined;
      const drivenAtAll = studio.physicsDrivers[r.output];
      return h(
        'div',
        {
          class: `rule${r.enabled ? '' : ' disabled'}`,
          'data-rule': r.id,
          'data-output': r.output,
        },
        h(
          'label',
          { class: 'check', title: 'Enabled' },
          h('input', {
            type: 'checkbox',
            checked: r.enabled,
            'aria-label': 'Enabled',
            onchange: (e: Event) =>
              update(r.id, { enabled: (e.target as HTMLInputElement).checked }),
          }),
        ),
        h(
          'div',
          { class: 'io' },
          h('input', {
            list: 'dl-inputs',
            value: r.input,
            'aria-label': 'Input',
            class: 'in-id',
            onchange: (e: Event) => {
              const v = (e.target as HTMLInputElement).value.trim();
              const info = inputInfo(v);
              update(r.id, info ? { input: v, inMin: info.min, inMax: info.max } : { input: v });
            },
          }),
          h('span', { class: 'arrow' }, '→'),
          h('input', {
            list: 'dl-params',
            value: r.output,
            'aria-label': 'Parameter',
            class: `out-id${unknownOut ? ' warn' : ''}`,
            title: unknownOut ? 'This model has no such parameter' : '',
            onchange: (e: Event) =>
              update(r.id, { output: (e.target as HTMLInputElement).value.trim() }),
          }),
        ),
        drivenAtAll
          ? h(
              'p',
              { class: 'hint physics', ...(driver ? { 'data-driver': driver } : {}) },
              h(
                'label',
                { class: 'check' },
                h('input', {
                  type: 'checkbox',
                  class: 'follow-physics',
                  checked: r.followPhysics !== false,
                  onchange: (e: Event) =>
                    update(r.id, {
                      followPhysics: (e.target as HTMLInputElement).checked ? undefined : false,
                    }),
                }),
                `Driven by physics from ${drivenAtAll.from}${drivenAtAll.reflect ? ' (reversed)' : ''}`,
              ),
              driver
                ? `: physics overwrites ${r.output} every frame, so this rule writes ${driver} instead (scaled between their ranges${drivenAtAll.reflect ? ', mirrored' : ''}).`
                : r.followPhysics === false
                  ? `: this rule writes ${r.output} itself (physics overwrites it).`
                  : `: another rule writes ${drivenAtAll.from} already.`,
            )
          : '',
        h(
          'div',
          { class: 'ranges' },
          h('span', {}, 'in'),
          numberInput(r.inMin, (v) => update(r.id, { inMin: v }), { label: 'Input min' }),
          numberInput(r.inMax, (v) => update(r.id, { inMax: v }), { label: 'Input max' }),
          h('span', {}, 'out'),
          numberInput(r.outMin, (v) => update(r.id, { outMin: v }), { label: 'Output min' }),
          numberInput(r.outMax, (v) => update(r.id, { outMax: v }), { label: 'Output max' }),
        ),
        h(
          'div',
          { class: 'opts' },
          h(
            'label',
            {},
            h('input', {
              type: 'checkbox',
              checked: r.invert,
              onchange: (e: Event) =>
                update(r.id, { invert: (e.target as HTMLInputElement).checked }),
            }),
            'Invert',
          ),
          h(
            'label',
            {},
            h('input', {
              type: 'checkbox',
              checked: r.clamp,
              onchange: (e: Event) =>
                update(r.id, { clamp: (e.target as HTMLInputElement).checked }),
            }),
            'Limit Range',
          ),
          h(
            'label',
            { class: 'smooth' },
            'Smoothing',
            h('input', {
              type: 'range',
              min: 0,
              max: 1,
              step: 0.05,
              value: r.smoothing,
              'aria-label': 'Smoothing',
              onchange: (e: Event) =>
                update(r.id, { smoothing: Number((e.target as HTMLInputElement).value) }),
            }),
            h(
              'select',
              {
                class: 'smoother',
                'aria-label': 'How smoothing works',
                title:
                  'Rate limit: small changes pass at once and the value rises faster than it falls, as a mouth does with speech (the default for voice inputs). Gradual: an even easing of every change (the default for the rest).',
                onchange: (e: Event) => {
                  const v = (e.target as HTMLSelectElement).value as SmootherKind;
                  update(r.id, { smoother: v });
                },
              },
              h('option', { value: 'rate', selected: ruleSmoother(r) === 'rate' }, 'Rate limit'),
              h(
                'option',
                { value: 'exponential', selected: ruleSmoother(r) === 'exponential' },
                'Gradual',
              ),
            ),
          ),
          h(
            'button',
            {
              class: 'icon danger',
              title: 'Remove rule',
              'aria-label': 'Remove rule',
              onclick: () =>
                void studio
                  .run('set_mapping', { rules: s.mapping.filter((x) => x.id !== r.id) })
                  .catch(() => undefined),
            },
            '✕',
          ),
        ),
        h('div', { class: 'livebox' }, inp, bar, out),
        source,
      );
    });
    el.append(
      inputList,
      paramList,
      h(
        'div',
        { class: 'row' },
        h(
          'button',
          {
            onclick: () =>
              void studio.run('set_mapping', {
                rules: [
                  ...s.mapping,
                  makeRule({
                    input: 'HeadYaw',
                    output: params[0]?.id ?? 'ParamAngleX',
                    inMin: -30,
                    inMax: 30,
                    outMin: -30,
                    outMax: 30,
                  }),
                ],
              }),
          },
          'Add rule',
        ),
        h(
          'button',
          {
            onclick: () =>
              confirm(
                'Auto-Setup: replace the mapping with rules from the tracking inputs to this model’s standard parameter IDs?',
              ) &&
              void studio
                .run('set_mapping', { rules: defaultRules(studio.parameters.map((p) => p.id)) })
                .catch(() => undefined),
          },
          'Auto-Setup',
        ),
      ),
      s.mapping.length
        ? h('div', { class: 'rules' }, rows)
        : h(
            'p',
            { class: 'hint' },
            'No rules. This model has none of the standard parameters; add rules by hand.',
          ),
    );
  }

  function live(): void {
    const s = studio.settings;
    if (!s) return;
    const animations = studio.activeAnimations();
    const pluginInputs = new Set(studio.plugins?.injectedInputs(performance.now()).keys() ?? []);
    const redirects = studio.trackingRedirects;
    for (const r of s.mapping) {
      const c = liveCells.get(r.id);
      if (!c) continue;
      const i = readInput(studio.lastInputs, r.input);
      const o = studio.lastParams[r.output];
      c.inp.textContent = i === undefined ? '–' : i.toFixed(2);
      c.out.textContent = o === undefined ? '–' : o.toFixed(2);
      const src = parameterSource({
        input: r.input,
        output: r.output,
        enabled: r.enabled,
        provided: studio.isProvided(r.output),
        idleWeight: studio.handover.weight(redirects[r.output]?.from ?? r.output),
        redirectedTo: redirects[r.output]?.from,
        physicsFrom: r.followPhysics === false ? undefined : studio.physicsDrivers[r.output]?.from,
        pluginInputs,
        animations,
      });
      if (c.source.textContent !== src.text) {
        c.source.textContent = src.text;
        c.source.dataset.source = src.kind;
      }
      const lo = Math.min(r.outMin, r.outMax);
      const hi = Math.max(r.outMin, r.outMax);
      c.bar.style.setProperty(
        '--v',
        o === undefined || hi === lo ? '0' : String(Math.max(0, Math.min(1, (o - lo) / (hi - lo)))),
      );
    }
  }

  refresh();
  return { el, refresh, live };
}

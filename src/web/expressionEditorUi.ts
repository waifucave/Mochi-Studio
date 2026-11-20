/**
 * The expression editor, in the Hotkeys tab: the model's expressions, each switched on and off for testing
 * without hotkeys, edited, exported or removed; hotkeys for the expressions
 * that lack one; and the editor itself, where parameters are ticked and given
 * a value and a mode, with a warning for physics outputs.
 */
import {
  BLENDS,
  clampDraftValue,
  clampFade,
  expressionFileText,
  newDraft,
  physicsConflicts,
  startValue,
  type DraftParameter,
  type ExpressionBlend,
  type ExpressionDraft,
} from '../core/expressionEditor';
import type { ParameterInfo } from '../core/runtime';
import { downloadText, h } from './dom';
import type { Studio } from './studio';

type Notify = (message: string, kind?: 'error') => void;

const BLEND_LABELS: Record<ExpressionBlend, string> = {
  Overwrite: 'Set to',
  Add: 'Add',
  Multiply: 'Multiply by',
};

interface Editing {
  draft: ExpressionDraft;
  /** The file being changed; undefined for a new expression. */
  file: string | undefined;
  /** One of the model's own expressions: its name comes from the model's files. */
  original: boolean;
}

export function expressionEditor(
  studio: Studio,
  notify: Notify,
): { el: HTMLElement; refresh(): void } {
  const list = h('div', { class: 'expr-list' });
  const editorBox = h('div', { class: 'expr-editor', id: 'expression-editor', hidden: true });
  const createHotkeys = h('button', {
    id: 'expr-create-hotkeys',
    onclick: () => {
      const n = studio.createExpressionHotkeys();
      notify(
        n
          ? `Made ${n} hotkey${n === 1 ? '' : 's'}. Give ${n === 1 ? 'it' : 'them'} keys in the list above.`
          : 'Every expression has a hotkey already.',
      );
      refresh();
    },
  });
  const el = h(
    'div',
    { class: 'expressions' },
    h('h2', {}, 'Expressions'),
    h(
      'p',
      { class: 'hint' },
      'Switch expressions on and off here to try them, without hotkeys. Make your own, or change the model’s: tick the parameters they move and give each a value.',
    ),
    list,
    h(
      'div',
      { class: 'row' },
      h(
        'button',
        { id: 'expr-new', onclick: () => open(newDraft(''), undefined, false) },
        'New expression',
      ),
      createHotkeys,
    ),
    editorBox,
  );

  let editing: Editing | undefined;
  let previewOn = false;
  let previewQueued = false;

  const physicsOutputs = (): Set<string> =>
    new Set(studio.runtime.physicsFacts()?.physicsInputs.keys() ?? []);

  /** Shows the draft on the model (once per frame at most) while "show it" is ticked. */
  function preview(): void {
    if (!previewOn || !editing || previewQueued) return;
    previewQueued = true;
    requestAnimationFrame(() => {
      previewQueued = false;
      if (previewOn && editing) studio.previewExpression(editing.draft);
    });
  }

  function close(): void {
    editing = undefined;
    if (previewOn) studio.previewExpression(undefined);
    previewOn = false;
    editorBox.hidden = true;
    editorBox.replaceChildren();
  }

  function fileName(e: Editing): string {
    return (e.file ?? `${e.draft.name.trim() || 'Expression'}.exp3.json`).split('/').pop()!;
  }

  async function save(): Promise<void> {
    const e = editing;
    if (!e) return;
    try {
      const file = await studio.saveExpression(e.draft, e.file);
      notify(
        studio.savesExpressionsToFolder
          ? `Saved ${file} into the model folder.`
          : `Saved “${e.draft.name.trim()}” with this model’s settings in this browser. Export it to keep the file.`,
      );
      close();
      refresh();
    } catch (err) {
      notify((err as Error).message, 'error');
    }
  }

  function paramRow(p: ParameterInfo, physics: ReadonlySet<string>): HTMLElement {
    const e = editing!;
    const min = p.min ?? 0;
    const max = p.max ?? 1;
    const def = p.default ?? min;
    const entry = (): DraftParameter | undefined => e.draft.parameters.find((x) => x.id === p.id);
    const used = h('input', {
      type: 'checkbox',
      class: 'expr-use',
      checked: !!entry(),
      'aria-label': `Use ${p.name || p.id}`,
    });
    const blend = h(
      'select',
      { class: 'expr-blend', 'aria-label': `Mode of ${p.name || p.id}` },
      ...BLENDS.map((b) =>
        h('option', { value: b, selected: (entry()?.blend ?? 'Overwrite') === b }, BLEND_LABELS[b]),
      ),
    );
    const value = h('input', {
      type: 'number',
      class: 'expr-value',
      step: 'any',
      'aria-label': `Value of ${p.name || p.id}`,
    });
    const slider = h('input', {
      type: 'range',
      class: 'expr-slider',
      step: 'any',
      'aria-hidden': 'true',
      tabindex: -1,
    });
    const bounds = (b: ExpressionBlend): [number, number] => {
      const span = Math.abs(max - min);
      return b === 'Overwrite'
        ? [Math.min(min, max), Math.max(min, max)]
        : b === 'Add'
          ? [-span, span]
          : [-2, 2];
    };
    const show = (): void => {
      const x = entry();
      const b = x?.blend ?? (blend.value as ExpressionBlend);
      const [lo, hi] = bounds(b);
      slider.min = String(lo);
      slider.max = String(hi);
      slider.step = String((hi - lo) / 200 || 0.01);
      const v = x?.value ?? startValue(b, def, min, max);
      value.value = String(Math.round(v * 1000) / 1000);
      slider.value = String(v);
      for (const c of [blend, value, slider]) c.disabled = !x;
      row.classList.toggle('on', !!x);
    };
    const set = (v: number): void => {
      const x = entry();
      if (!x) return;
      x.value = clampDraftValue(x.blend, v, min, max);
      show();
      warnings();
      preview();
    };
    used.addEventListener('change', () => {
      if (used.checked) {
        const b = blend.value as ExpressionBlend;
        e.draft.parameters.push({ id: p.id, blend: b, value: startValue(b, def, min, max) });
      } else e.draft.parameters = e.draft.parameters.filter((x) => x.id !== p.id);
      show();
      warnings();
      preview();
    });
    blend.addEventListener('change', () => {
      const x = entry();
      if (!x) return;
      x.blend = blend.value as ExpressionBlend;
      x.value = startValue(x.blend, def, min, max);
      show();
      preview();
    });
    value.addEventListener('change', () => set(Number(value.value)));
    slider.addEventListener('input', () => set(Number(slider.value)));
    const row = h(
      'div',
      { class: 'expr-param', 'data-param': p.id },
      h(
        'label',
        { class: 'check', title: p.id },
        used,
        p.name && p.name !== p.id ? `${p.name} (${p.id})` : p.id,
      ),
      blend,
      slider,
      value,
      physics.has(p.id)
        ? h(
            'span',
            { class: 'warn expr-physics' },
            'Physics overwrites this parameter, so the expression cannot move it.',
          )
        : '',
    );
    show();
    return row;
  }

  let warnings = (): void => undefined;

  function open(draft: ExpressionDraft, file: string | undefined, original: boolean): void {
    if (!studio.model || !studio.info) return notify('Load a model first.', 'error');
    if (previewOn) studio.previewExpression(undefined);
    previewOn = false;
    editing = { draft, file, original };
    const e = editing;
    const physics = physicsOutputs();
    const params = studio.info.parameters;
    const rows = h('div', { class: 'expr-params' });
    const filter = h('input', {
      type: 'search',
      id: 'expr-filter',
      placeholder: 'Find a parameter',
      'aria-label': 'Find a parameter',
    });
    const onlyTicked = h('input', { type: 'checkbox', id: 'expr-only-ticked' });
    const applyFilter = (): void => {
      const q = filter.value.trim().toLowerCase();
      for (const r of rows.children as HTMLCollectionOf<HTMLElement>) {
        const id = r.dataset.param ?? '';
        const label = r.textContent?.toLowerCase() ?? '';
        const ticked = e.draft.parameters.some((x) => x.id === id);
        r.hidden =
          (q !== '' && !label.includes(q) && !id.toLowerCase().includes(q)) ||
          (onlyTicked.checked && !ticked);
      }
    };
    filter.addEventListener('input', applyFilter);
    onlyTicked.addEventListener('change', applyFilter);
    const physicsWarning = h('p', { class: 'warn', id: 'expr-physics-warning', hidden: true });
    warnings = () => {
      const bad = physicsConflicts(e.draft, physics);
      physicsWarning.hidden = bad.length === 0;
      physicsWarning.textContent = bad.length
        ? `Physics overwrites ${bad.join(', ')} every frame: the expression cannot move ${bad.length === 1 ? 'it' : 'them'}. Untick ${bad.length === 1 ? 'it' : 'them'}, or switch physics off in the Model tab.`
        : '';
    };
    const fade = (id: string, label: string, get: () => number, put: (v: number) => void) =>
      h(
        'label',
        {},
        label,
        h('input', {
          type: 'number',
          id,
          min: 0,
          max: 10,
          step: 0.1,
          value: get(),
          onchange: (ev: Event) => {
            put(clampFade(Number((ev.target as HTMLInputElement).value)));
          },
        }),
      );
    const previewBox = h('input', {
      type: 'checkbox',
      id: 'expr-preview',
      onchange: (ev: Event) => {
        previewOn = (ev.target as HTMLInputElement).checked;
        if (previewOn) preview();
        else studio.previewExpression(undefined);
      },
    });
    for (const p of params) rows.append(paramRow(p, physics));
    editorBox.replaceChildren(
      h('h3', {}, file ? `Edit “${draft.name}”` : 'New expression'),
      h(
        'label',
        {},
        'Name',
        h('input', {
          id: 'expr-name',
          value: draft.name,
          maxlength: 100,
          disabled: original,
          title: original
            ? 'The model’s files name this expression.'
            : 'Hotkeys and plugins know it by this name.',
          oninput: (ev: Event) => {
            e.draft.name = (ev.target as HTMLInputElement).value;
          },
        }),
      ),
      h(
        'div',
        { class: 'row' },
        fade(
          'expr-fade-in',
          'Fade in (s)',
          () => e.draft.fadeIn,
          (v) => (e.draft.fadeIn = v),
        ),
        fade(
          'expr-fade-out',
          'Fade out (s)',
          () => e.draft.fadeOut,
          (v) => (e.draft.fadeOut = v),
        ),
      ),
      h(
        'label',
        { class: 'check' },
        previewBox,
        'Show it on the model while editing (this window only)',
      ),
      h('div', { class: 'row' }, filter, h('label', { class: 'check' }, onlyTicked, 'Only ticked')),
      physicsWarning,
      rows,
      h(
        'div',
        { class: 'row' },
        h(
          'button',
          { class: 'primary', id: 'expr-save', onclick: () => void save() },
          studio.savesExpressionsToFolder ? 'Save into the model folder' : 'Save',
        ),
        h(
          'button',
          {
            id: 'expr-export-draft',
            title: 'Download the .exp3.json file',
            onclick: () => downloadText(fileName(e), expressionFileText(e.draft)),
          },
          'Export',
        ),
        h('button', { id: 'expr-cancel', onclick: () => close() }, 'Cancel'),
      ),
    );
    warnings();
    editorBox.hidden = false;
    editorBox.scrollIntoView?.({ block: 'nearest' });
  }

  function refresh(): void {
    const m = studio.model;
    list.replaceChildren();
    if (!m) {
      close();
      list.append(h('p', { class: 'hint' }, 'Load a model to see its expressions.'));
      createHotkeys.textContent = 'Create hotkeys for expressions without one';
      createHotkeys.disabled = true;
      return;
    }
    const missing = studio.expressionsWithoutHotkey();
    createHotkeys.textContent = missing.length
      ? `Create hotkeys for ${missing.length} expression${missing.length === 1 ? '' : 's'} without one`
      : 'Every expression has a hotkey';
    createHotkeys.disabled = missing.length === 0;
    if (!m.manifest.expressions.length)
      list.append(h('p', { class: 'hint' }, 'This model has no expressions yet.'));
    for (const x of m.manifest.expressions) {
      const on = studio.activeExpressions.has(x.name);
      const own = studio.ownExpression(x.file);
      const base = studio.isBaseExpression(x.file);
      list.append(
        h(
          'div',
          { class: 'expr-row row', 'data-expression': x.name },
          h('span', { class: 'expr-name' }, x.name),
          h('span', { class: 'hint' }, x.file),
          own ? h('span', { class: 'chip' }, base ? 'changed here' : 'made here') : '',
          h(
            'button',
            {
              class: `expr-test${on ? ' on' : ''}`,
              'aria-pressed': String(on),
              title: 'Switch it on or off to try it (no hotkey needed)',
              onclick: () => {
                studio.setExpression(x.name, !studio.activeExpressions.has(x.name));
                refresh();
              },
            },
            on ? 'On' : 'Off',
          ),
          h(
            'button',
            {
              class: 'expr-edit',
              onclick: () =>
                void studio
                  .expressionDraft(x.name)
                  .then(({ draft, file }) => open(draft, file, base))
                  .catch((err: Error) =>
                    notify(`Could not open ${x.file}: ${err.message}`, 'error'),
                  ),
            },
            'Edit',
          ),
          h(
            'button',
            {
              class: 'expr-export',
              title: 'Download the .exp3.json file',
              onclick: () =>
                void studio
                  .expressionText(x.file)
                  .then((t) => downloadText(x.file.split('/').pop()!, t))
                  .catch((err: Error) => notify(err.message, 'error')),
            },
            'Export',
          ),
          own
            ? h(
                'button',
                {
                  class: 'expr-remove',
                  title: base
                    ? 'Go back to the model’s own file'
                    : studio.savesExpressionsToFolder
                      ? 'Take it off the list (the file stays in the model folder)'
                      : 'Delete it from this model’s settings',
                  onclick: () => void studio.removeOwnExpression(x.file).then(refresh),
                },
                base ? 'Undo changes' : 'Remove',
              )
            : '',
        ),
      );
    }
  }

  studio.events.on('modelLoaded', () => {
    close();
    refresh();
  });
  studio.events.on('modelUnloaded', refresh);
  studio.events.on('expressionListChanged', refresh);
  studio.events.on('expressionsChanged', () => {
    if (!el.contains(document.activeElement) || !editing) refresh();
  });
  refresh();
  return { el, refresh };
}

/**
 * Item scenes in the Items sheet: make
 * a scene from the current items, picking which ones it holds, name it, and
 * optionally put it in a group; turn scenes on and off; and make a «Toggle
 * Item Scene» hotkey for one.
 */
import { h } from './dom';
import type { Studio } from './studio';

type Notify = (message: string, kind?: 'error') => void;

export function itemScenesPanel(
  studio: Studio,
  notify: Notify,
): { el: HTMLElement; refresh(): void } {
  const list = h('div', { class: 'scene-list' });
  const editorBox = h('div', { class: 'scene-editor', id: 'scene-editor', hidden: true });
  const groups = h('datalist', { id: 'scene-groups' });
  const el = h(
    'div',
    { class: 'item-scenes', id: 'item-scenes' },
    h('h2', {}, 'Item scenes'),
    h(
      'p',
      { class: 'hint' },
      'A scene is a set of items where they are now. Turning it on shows them there; turning it off hides them. In a group, one scene is on at a time. A hotkey can toggle a scene, with a fade.',
    ),
    list,
    h(
      'div',
      { class: 'row' },
      h('button', { id: 'scene-new', onclick: () => open(undefined) }, 'New scene from the items…'),
    ),
    editorBox,
    groups,
  );

  /** The editor: a name, a group, and a tick per item (those shown now ticked for a new scene). */
  function open(id: string | undefined): void {
    if (!studio.settings) return notify('Load a model first.', 'error');
    if (!studio.items.length)
      return notify('Add items first: a scene holds some of them.', 'error');
    const scene = id ? studio.itemScenes.find((x) => x.id === id) : undefined;
    const held = new Set(
      scene
        ? scene.items.map((i) => i.id)
        : studio.items.filter((i) => studio.isItemVisible(i.id)).map((i) => i.id),
    );
    const name = h('input', {
      id: 'scene-name',
      value: scene?.name ?? `Scene ${studio.itemScenes.length + 1}`,
      maxlength: 100,
      'aria-label': 'Scene name',
    });
    const group = h('input', {
      id: 'scene-group',
      value: scene?.group ?? '',
      maxlength: 64,
      list: 'scene-groups',
      placeholder: 'None',
      'aria-label': 'Group',
      title: 'Turning one scene of a group on turns the group’s others off',
    });
    const ticks = studio.items.map((i) =>
      h(
        'label',
        { class: 'check scene-item', 'data-item': i.id },
        h('input', {
          type: 'checkbox',
          checked: held.has(i.id),
          'aria-label': `Include ${i.label}`,
        }),
        i.label,
      ),
    );
    const picked = (): string[] =>
      ticks.filter((t) => t.querySelector('input')!.checked).map((t) => t.dataset.item!);
    editorBox.replaceChildren(
      h('h3', {}, scene ? `Edit “${scene.name}”` : 'New scene'),
      h('label', {}, 'Name', name),
      h('label', {}, 'Group (optional)', group),
      h(
        'p',
        { class: 'hint' },
        'Tick the items the scene holds. They are kept where they are now.',
      ),
      h('div', { class: 'scene-items' }, ticks),
      h(
        'div',
        { class: 'row' },
        h(
          'button',
          {
            class: 'primary',
            id: 'scene-save',
            onclick: () => {
              const items = picked();
              if (!items.length) return notify('Tick at least one item.', 'error');
              if (scene)
                studio.updateItemScene(scene.id, { name: name.value, group: group.value, items });
              else studio.createItemScene(name.value, group.value, items);
              close();
              refresh();
            },
          },
          'Save scene',
        ),
        h('button', { id: 'scene-cancel', onclick: () => close() }, 'Cancel'),
      ),
    );
    editorBox.hidden = false;
  }

  function close(): void {
    editorBox.hidden = true;
    editorBox.replaceChildren();
  }

  /** A «Toggle Item Scene» hotkey for a scene (no keys yet), in the Hotkeys tab. */
  function makeHotkey(id: string, name: string): void {
    const s = studio.settings;
    if (!s) return;
    if (s.hotkeys.some((x) => x.action.type === 'itemScene' && x.action.scene === id))
      return notify(`“${name}” has a hotkey already (Settings → Hotkeys).`);
    studio.updateSettings({
      hotkeys: [
        ...s.hotkeys,
        {
          id: `h${Date.now().toString(36)}`,
          label: name,
          keys: '',
          button: true,
          action: { type: 'itemScene', scene: id, fade: 0.5 },
        },
      ],
    });
    notify(`Made a hotkey for “${name}”. Give it keys in Settings → Hotkeys.`);
  }

  function refresh(): void {
    list.replaceChildren();
    const scenes = studio.itemScenes;
    groups.replaceChildren(
      ...[...new Set(scenes.flatMap((x) => (x.group ? [x.group] : [])))].map((g) =>
        h('option', { value: g }),
      ),
    );
    if (!studio.settings) return;
    if (!scenes.length) list.append(h('p', { class: 'hint' }, 'No scenes yet.'));
    for (const x of scenes) {
      const on = studio.isItemSceneOn(x.id);
      const names = x.items
        .map((i) => studio.items.find((e) => e.id === i.id)?.label)
        .filter(Boolean);
      list.append(
        h(
          'div',
          { class: 'scene row', 'data-scene': x.id },
          h('span', { class: 'scene-name' }, x.name),
          x.group ? h('span', { class: 'chip' }, x.group) : '',
          h('span', { class: 'hint' }, names.length ? names.join(', ') : 'its items are gone'),
          h(
            'button',
            {
              class: `scene-toggle${on ? ' on' : ''}`,
              'aria-pressed': String(on),
              onclick: () => {
                studio.setItemScene(x.id, !studio.isItemSceneOn(x.id), 0.3);
                refresh();
              },
            },
            on ? 'On' : 'Off',
          ),
          h('button', { class: 'scene-edit', onclick: () => open(x.id) }, 'Edit'),
          h(
            'button',
            { class: 'scene-hotkey', onclick: () => makeHotkey(x.id, x.name) },
            'Make hotkey',
          ),
          h(
            'button',
            {
              class: 'icon danger scene-remove',
              'aria-label': `Remove the scene ${x.name}`,
              title: 'Remove the scene (its items stay)',
              onclick: () => {
                studio.removeItemScene(x.id);
                refresh();
              },
            },
            '✕',
          ),
        ),
      );
    }
  }

  studio.events.on('itemScenesChanged', refresh);
  studio.events.on('modelLoaded', () => {
    close();
    refresh();
  });
  studio.events.on('modelUnloaded', refresh);
  refresh();
  return { el, refresh };
}

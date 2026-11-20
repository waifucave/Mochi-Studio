/**
 * The plugin API's interface: the switch and the allowed plugins (Agents
 * tab), the question when a plugin asks to be allowed, and the header's
 * indicator of connected plugins.
 */
import { h } from './dom';
import type { AgentLink } from './agentLink';
import type { PluginHost } from './pluginHost';

/** A data URL for a plugin's base64 icon (PNG or JPEG). */
function iconUrl(icon: string): string {
  return `data:image/${icon.startsWith('/9j/') ? 'jpeg' : 'png'};base64,${icon}`;
}

export function pluginsUi(
  host: PluginHost,
  link: AgentLink,
  opts: { bridgeUrl: () => string; desktop: boolean },
): {
  panel: HTMLElement;
  chip: HTMLElement;
  dialog: HTMLElement;
  imageDialog: HTMLElement;
  selectionDialog: HTMLElement;
  outline: SVGSVGElement;
} {
  const toggle = h('input', { type: 'checkbox', id: 'plugins-toggle' });
  const status = h('p', { class: 'hint', id: 'plugins-status' });
  const list = h('ul', { class: 'plugins', id: 'plugins-list' });
  const chip = h('span', { class: 'chip', id: 'plugins-indicator', hidden: true });
  const pairInput = h('input', {
    id: 'plugins-pair-code',
    inputmode: 'numeric',
    maxlength: 6,
    placeholder: '6-digit code',
    'aria-label': 'Pairing code',
  });
  const pairBox = h(
    'div',
    { class: 'row', hidden: true },
    pairInput,
    h('button', { onclick: () => link.pair(pairInput.value) }, 'Pair'),
  );
  toggle.addEventListener('change', () => {
    if (toggle.checked) link.enablePlugins(opts.bridgeUrl());
    else link.disablePlugins();
    render();
  });

  const panel = h(
    'section',
    { class: 'plugins-section' },
    h('h2', {}, 'Plugins'),
    h(
      'p',
      { class: 'hint' },
      'Plugins made for VTube Studio (stream tools, controllers, audio meters…) can connect to Mochi Studio unchanged. Each one asks you first. It can then trigger hotkeys, load and move the model, switch expressions, tint the model and feed its own inputs into the mapping. It never sees the camera image or hears the microphone.',
    ),
    h('label', { class: 'check' }, toggle, 'Plugin server (localhost only)'),
    status,
    pairBox,
    h('h3', {}, 'Allowed plugins'),
    list,
  );

  // The question when a plugin asks to be allowed.
  let asking: string | undefined;
  const dialog = h('div', {
    class: 'modal',
    id: 'plugin-approval',
    role: 'dialog',
    'aria-modal': 'true',
    'aria-labelledby': 'plugin-approval-title',
    hidden: true,
  });
  const answer = (allow: boolean): void => {
    if (asking) host.approve(asking, allow);
    asking = undefined;
    dialog.hidden = true;
  };
  host.events.on('approval', ({ requestId, name, developer, icon, permission }) => {
    asking = requestId;
    const what = permission ? PERMISSION_TEXT[permission] : undefined;
    dialog.dataset.permission = permission ?? '';
    dialog.replaceChildren(
      h(
        'div',
        { class: 'modal-box' },
        icon
          ? h('img', { class: 'plugin-icon', src: iconUrl(icon), alt: '', width: 64, height: 64 })
          : '',
        h(
          'h2',
          { id: 'plugin-approval-title' },
          permission ? 'Give this plugin a permission?' : 'Allow this plugin?',
        ),
        permission
          ? h(
              'p',
              {},
              h('strong', {}, name),
              ' by ',
              h('strong', {}, developer),
              ` asks to ${what ?? permission}.`,
            )
          : h(
              'p',
              {},
              h('strong', {}, name),
              ' by ',
              h('strong', {}, developer),
              ' wants to connect.',
            ),
        h(
          'p',
          { class: 'hint' },
          permission
            ? 'You can take the permission back in the settings’ General tab, under Plugins.'
            : 'If you allow it, it can trigger hotkeys, load and move the model and items, switch expressions, tint the model and feed inputs, until you revoke it in the settings’ General tab. It cannot see your camera or hear your microphone, and it reads tracking values only if you allow that separately. Allow only plugins you started yourself.',
        ),
        h(
          'div',
          { class: 'row' },
          h(
            'button',
            { class: 'primary', id: 'plugin-allow', onclick: () => answer(true) },
            'Allow',
          ),
          h('button', { id: 'plugin-deny', onclick: () => answer(false) }, 'Deny'),
        ),
      ),
    );
    dialog.hidden = false;
    (dialog.querySelector('#plugin-deny') as HTMLButtonElement | null)?.focus();
  });
  host.events.on('approvalCancelled', ({ requestId }) => {
    if (asking !== requestId) return;
    asking = undefined;
    dialog.hidden = true;
  });
  dialog.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') answer(false);
  });

  function render(): void {
    toggle.checked = link.pluginsOn;
    const connected = link.state === 'connected';
    pairBox.hidden = !(link.pluginsOn && link.state === 'pairing');
    status.dataset.state = host.on ? 'on' : 'off';
    status.textContent = !link.pluginsOn
      ? 'Off. Plugins cannot connect.'
      : link.state === 'pairing'
        ? 'The bridge asks for its pairing code: it is printed where the bridge runs.'
        : !connected
          ? opts.desktop
            ? 'Starting…'
            : 'Waiting for the bridge: start it with “npm run bridge” (plugins connect to it, not to this page).'
          : host.problem
            ? host.problem
            : host.on && host.port
              ? `On: plugins connect to ws://localhost:${host.port}${host.port !== 8001 ? ' (port 8001 was taken; tell the plugin this port)' : ''}.`
              : 'Starting…';
    list.replaceChildren(
      ...(host.plugins.length
        ? host.plugins.map((p) =>
            h(
              'li',
              { class: 'plugin', 'data-plugin': p.id },
              p.icon
                ? h('img', {
                    class: 'plugin-icon',
                    src: iconUrl(p.icon),
                    alt: '',
                    width: 32,
                    height: 32,
                  })
                : h('span', { class: 'plugin-icon', 'aria-hidden': 'true' }),
              h(
                'div',
                {},
                h('strong', {}, p.name),
                ` by ${p.developer}`,
                p.sessions ? h('span', { class: 'chip', 'data-on': 'true' }, 'connected') : '',
                h(
                  'label',
                  {
                    class: 'check',
                    title:
                      'Tracking data is what the camera measures (head angles, eyes, mouth) and the model values it drives. Off: the plugin reads default values instead.',
                  },
                  h('input', {
                    type: 'checkbox',
                    class: 'plugin-tracking',
                    checked: p.trackingData,
                    onchange: (e: Event) =>
                      host.setTrackingData(p.id, (e.target as HTMLInputElement).checked),
                  }),
                  'May read tracking data',
                ),
                ...p.permissions.map((perm) =>
                  h(
                    'p',
                    { class: 'hint plugin-permission', 'data-permission': perm },
                    `May ${PERMISSION_TEXT[perm] ?? perm}. `,
                    h(
                      'button',
                      {
                        class: 'link plugin-permission-revoke',
                        onclick: () => host.revokePermission(p.id, perm),
                      },
                      'Take back',
                    ),
                  ),
                ),
                (() => {
                  const params = host.parameters.filter((x) => x.pluginId === p.id);
                  return params.length
                    ? h('p', { class: 'hint' }, `Inputs: ${params.map((x) => x.name).join(', ')}`)
                    : '';
                })(),
              ),
              h(
                'button',
                {
                  class: 'plugin-revoke',
                  title: 'Revoke: it must ask again, and its inputs are removed',
                  onclick: () => host.revoke(p.id),
                },
                'Revoke',
              ),
            ),
          )
        : [h('li', { class: 'hint' }, 'None yet.')]),
    );
    const on = host.connectedPlugins;
    chip.hidden = on.length === 0;
    chip.dataset.on = String(on.length > 0);
    chip.textContent = `● Plugin: ${on.map((p) => p.name).join(', ')}`;
  }
  host.events.on('changed', render);
  link.events.on('state', render);
  render();

  // A plugin's own image: shown only if the person says yes (one question at a time).
  const imageDialog = h('div', {
    class: 'modal',
    id: 'plugin-image',
    role: 'dialog',
    'aria-modal': 'true',
    'aria-labelledby': 'plugin-image-title',
    hidden: true,
  });
  const imageQueue: Array<{
    id: string;
    pluginName: string;
    url: string;
    width: number;
    height: number;
    seconds: number;
  }> = [];
  let imageTimer: ReturnType<typeof setInterval> | undefined;
  const showImage = (): void => {
    if (imageTimer) clearInterval(imageTimer);
    const q = imageQueue[0];
    imageDialog.hidden = !q;
    if (!q) return;
    const left = h('span', { class: 'hint' });
    const until = q.seconds > 0 ? performance.now() + q.seconds * 1000 : 0;
    const tickLeft = (): void => {
      left.textContent = until
        ? ` (${Math.max(0, Math.ceil((until - performance.now()) / 1000))} s)`
        : '';
    };
    tickLeft();
    if (until) imageTimer = setInterval(tickLeft, 250);
    imageDialog.dataset.prompt = q.id;
    imageDialog.replaceChildren(
      h(
        'div',
        { class: 'modal-box' },
        h('h2', { id: 'plugin-image-title' }, 'Show this picture?'),
        h(
          'p',
          {},
          h('strong', {}, q.pluginName),
          ` wants to show this picture on the stage as an item (${q.width} × ${q.height}).`,
        ),
        h('img', { class: 'plugin-image-thumb', src: q.url, alt: 'The picture the plugin sent' }),
        h(
          'p',
          { class: 'hint' },
          'It stays for this session only, unless you keep it in Items. Saying no tells the plugin.',
          left,
        ),
        h(
          'div',
          { class: 'row' },
          h(
            'button',
            {
              class: 'primary',
              id: 'plugin-image-allow',
              onclick: () => host.items.answerPrompt(q.id, true),
            },
            'Show it',
          ),
          h(
            'button',
            { id: 'plugin-image-deny', onclick: () => host.items.answerPrompt(q.id, false) },
            'Don’t show',
          ),
        ),
      ),
    );
    (imageDialog.querySelector('#plugin-image-deny') as HTMLButtonElement | null)?.focus();
  };
  host.items.events.on('imagePrompt', (q) => {
    imageQueue.push(q);
    if (imageQueue.length === 1) showImage();
  });
  host.items.events.on('imagePromptEnd', ({ id }) => {
    const i = imageQueue.findIndex((q) => q.id === id);
    if (i < 0) return;
    imageQueue.splice(i, 1);
    if (i === 0) showImage();
  });
  imageDialog.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && imageQueue[0]) host.items.answerPrompt(imageQueue[0].id, false);
  });

  // Choosing art meshes for a plugin: a list beside the stage; clicking the model filters it.
  const selectionDialog = h('section', {
    class: 'sheet sheet-small selection',
    id: 'plugin-selection',
    role: 'dialog',
    'aria-labelledby': 'plugin-selection-title',
    hidden: true,
  });
  let selecting:
    { id: string; count: number; chosen: Set<string>; filter: string[] | undefined } | undefined;
  host.events.on('selection', (q) => {
    selecting = { id: q.id, count: q.count, chosen: new Set(q.active), filter: undefined };
    const listEl = h('ul', { class: 'selection-list', id: 'plugin-selection-list' });
    const countEl = h('p', { class: 'hint', id: 'plugin-selection-count' });
    const okBtn = h(
      'button',
      { class: 'primary', id: 'plugin-selection-ok' },
      'OK',
    ) as HTMLButtonElement;
    const showAll = h('button', { class: 'link', hidden: true }, 'Show all');
    const renderList = (): void => {
      const s = selecting;
      if (!s) return;
      const shown = s.filter ?? q.meshes;
      showAll.hidden = !s.filter;
      listEl.replaceChildren(
        ...shown.map((m) =>
          h(
            'li',
            {},
            h(
              'label',
              { class: 'check', title: m },
              h('input', {
                type: 'checkbox',
                'data-mesh': m,
                checked: s.chosen.has(m),
                onchange: (e: Event) => {
                  if ((e.target as HTMLInputElement).checked) s.chosen.add(m);
                  else s.chosen.delete(m);
                  renderCount();
                },
              }),
              m,
            ),
          ),
        ),
      );
      renderCount();
    };
    const renderCount = (): void => {
      const s = selecting;
      if (!s) return;
      const n = s.chosen.size;
      okBtn.disabled = s.count > 0 ? n !== s.count : n < 1;
      countEl.textContent =
        s.count > 0 ? `Chosen: ${n} of ${s.count}.` : `Chosen: ${n} (at least one).`;
    };
    showAll.addEventListener('click', () => {
      if (selecting) selecting.filter = undefined;
      renderList();
    });
    okBtn.addEventListener('click', () => {
      if (selecting) host.answerSelection(selecting.id, [...selecting.chosen]);
    });
    selectionDialog.replaceChildren(
      h(
        'div',
        { class: 'sheet-head' },
        h('h1', { id: 'plugin-selection-title' }, `${q.pluginName}: choose art meshes`),
      ),
      h(
        'div',
        { class: 'sheet-body' },
        h('p', { style: 'white-space: pre-line' }, q.text),
        h('p', { class: 'hint', style: 'white-space: pre-line' }, q.help),
        countEl,
        h(
          'div',
          { class: 'row' },
          okBtn,
          h(
            'button',
            {
              id: 'plugin-selection-cancel',
              onclick: () => selecting && host.answerSelection(selecting.id, undefined),
            },
            'Cancel',
          ),
          showAll,
        ),
        listEl,
      ),
    );
    selectionDialog.hidden = false;
    renderList();
    filterTo = (meshes) => {
      if (!selecting) return;
      selecting.filter = meshes;
      renderList();
    };
  });
  let filterTo: ((meshes: string[]) => void) | undefined;
  host.events.on('selectionFilter', ({ meshes }) => filterTo?.(meshes));
  host.events.on('selectionEnd', ({ id }) => {
    if (selecting?.id !== id) return;
    selecting = undefined;
    selectionDialog.hidden = true;
  });

  // The model's outline, when a plugin asks for it to be drawn.
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('class', 'model-outline');
  svg.setAttribute('aria-hidden', 'true');
  const poly = document.createElementNS('http://www.w3.org/2000/svg', 'polygon');
  svg.append(poly);
  svg.style.display = 'none';
  // Dots for ArtMeshAtPositionRequest's `visualize` (at most 100 at once), and the outline.
  const dots = document.createElementNS('http://www.w3.org/2000/svg', 'g');
  svg.append(dots);
  let outlineOn = false;
  const showSvg = (): void => {
    svg.style.display = outlineOn || dots.childElementCount ? '' : 'none';
    poly.style.display = outlineOn ? '' : 'none';
  };
  host.events.on('outline', ({ points }) => {
    outlineOn = !!points && points.length >= 3;
    if (points)
      poly.setAttribute(
        'points',
        points.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' '),
      );
    showSvg();
  });
  host.events.on('marker', ({ x, y, seconds }) => {
    if (dots.childElementCount >= 100) dots.firstElementChild?.remove();
    const c = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
    c.setAttribute('cx', x.toFixed(1));
    c.setAttribute('cy', y.toFixed(1));
    c.setAttribute('r', '6');
    c.setAttribute('class', 'model-marker');
    dots.append(c);
    showSvg();
    setTimeout(() => {
      c.remove();
      showSvg();
    }, seconds * 1000);
  });

  return { panel, chip, dialog, imageDialog, selectionDialog, outline: svg };
}

/** What the person is told a permission allows. */
const PERMISSION_TEXT: Record<string, string> = {
  LoadCustomImagesAsItems:
    'show pictures it sends as items on the stage (each one asks you first, if the plugin wants; they last for this session unless you keep them)',
};

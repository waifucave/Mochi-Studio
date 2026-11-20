/**
 * A phone as a face tracker: the Camera tab's section. The
 * switch (off by default) starts the bridge's phone tracker
 * (bridge/src/phone.ts); the section then shows the address to open on the
 * phone, with a QR code, the pairing code, the approved phones (each can be
 * revoked) and what the phone sends. Its frames go into the tracking like
 * the webcam's (Studio.feedFrame, source "phone").
 */
import qrcode from 'qrcode-generator';
import type { BridgeToHostPhone, PhoneInfo } from '../core/phoneProtocol';
import type { AgentLink } from './agentLink';
import { h, select } from './dom';
import type { Studio } from './studio';

type PhoneState = Extract<BridgeToHostPhone, { type: 'phone_state' }>;

/** A QR code of `text`, as an SVG of dark squares on white (scannable in dark mode too). */
export function qrSvg(text: string, label: string): SVGSVGElement {
  const qr = qrcode(0, 'M');
  qr.addData(text, 'Byte');
  qr.make();
  const n = qr.getModuleCount();
  const quiet = 4;
  const size = n + quiet * 2;
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', `0 0 ${size} ${size}`);
  svg.setAttribute('role', 'img');
  svg.setAttribute('aria-label', label);
  svg.setAttribute('shape-rendering', 'crispEdges');
  const bg = document.createElementNS(ns, 'rect');
  bg.setAttribute('width', String(size));
  bg.setAttribute('height', String(size));
  bg.setAttribute('fill', '#fff');
  svg.append(bg);
  let d = '';
  for (let r = 0; r < n; r++)
    for (let c = 0; c < n; c++) if (qr.isDark(r, c)) d += `M${c + quiet} ${r + quiet}h1v1h-1z`;
  const path = document.createElementNS(ns, 'path');
  path.setAttribute('d', d);
  path.setAttribute('fill', '#000');
  svg.append(path);
  return svg;
}

export function phonePanel(
  studio: Studio,
  link: AgentLink,
  opts: { bridgeUrl: () => string; desktop: boolean },
): { el: HTMLElement; refresh(): void } {
  let state: PhoneState | undefined;
  let frames = 0;
  let rate = 0;
  let lastFrameAt = 0;
  let face: boolean | undefined;
  let chosenUrl = 0;

  link.events.on('phone', (m) => {
    if (m.type === 'phone_state') {
      state = m;
      render();
      return;
    }
    // A phone's frame: into the tracking, stamped with this window's clock.
    lastFrameAt = performance.now();
    frames++;
    face = m.face;
    studio.feedFrame(
      {
        t: lastFrameAt,
        face: m.face,
        blendshapes: m.blendshapes,
        ...(m.matrix ? { matrix: m.matrix } : {}),
      },
      'phone',
    );
  });
  // The phone's rate, and whether it still sends.
  setInterval(() => {
    rate = frames;
    frames = 0;
    if (state?.on) renderStatus();
  }, 1000);

  const toggle = h('input', {
    type: 'checkbox',
    id: 'phone-toggle',
    onchange: (e: Event) => {
      if ((e.target as HTMLInputElement).checked) link.enablePhone(opts.bridgeUrl());
      else link.disablePhone();
      render();
    },
  });
  const status = h('p', { class: 'hint', id: 'phone-status', role: 'status' });
  // The bridge's own pairing (a browser, not the desktop app), as for plugins.
  const bridgeCode = h('input', {
    id: 'phone-bridge-code',
    inputmode: 'numeric',
    maxlength: 6,
    placeholder: '6-digit code',
    'aria-label': 'The bridge’s pairing code',
  });
  const bridgePair = h(
    'div',
    { class: 'row', hidden: true },
    bridgeCode,
    h('button', { onclick: () => link.pair(bridgeCode.value) }, 'Pair'),
  );
  const body = h('div', { class: 'phone-body' });
  const el = h(
    'section',
    { class: 'phone-section' },
    h('h3', {}, 'A phone as the face tracker'),
    h(
      'p',
      { class: 'hint' },
      'A phone on the same network can track your face instead of this computer’s camera: its browser runs the tracking and sends only the movements here. The phone’s camera picture never leaves the phone.',
    ),
    h('label', { class: 'check' }, toggle, 'Phone tracker (on the local network)'),
    status,
    bridgePair,
    body,
  );

  function renderStatus(): void {
    const sending = performance.now() - lastFrameAt < 1500;
    const connected = state?.phones.filter((p) => p.connected) ?? [];
    bridgePair.hidden = !(link.phoneOn && link.state === 'pairing');
    status.textContent = !link.phoneOn
      ? 'Off. Nothing listens on the network.'
      : link.state === 'pairing'
        ? 'The bridge asks for its pairing code: it is printed where the bridge runs.'
        : link.state !== 'connected'
          ? opts.desktop
            ? 'Starting…'
            : 'Waiting for the bridge: start it with “npm run bridge” (the phone connects to it).'
          : state?.problem
            ? state.problem
            : !state?.on
              ? 'Starting…'
              : connected.length
                ? sending
                  ? `${connected.map((p) => p.name).join(', ')} connected · ${face ? 'face found' : 'no face'} · ${rate} frames a second${studio.faceSource === 'webcam' && studio.cameraOn ? ' · the webcam has your face now' : ''}`
                  : `${connected.map((p) => p.name).join(', ')} connected, not tracking yet.`
                : 'On. No phone connected.';
    status.dataset.state = state?.on ? 'on' : 'off';
  }

  function phoneRow(p: PhoneInfo): HTMLElement {
    return h(
      'li',
      { class: 'phone', 'data-phone': p.id },
      h('strong', {}, p.name),
      p.connected
        ? h('span', { class: 'chip', 'data-on': 'true' }, 'connected')
        : h(
            'span',
            { class: 'hint' },
            p.lastSeen ? ` last seen ${new Date(p.lastSeen).toLocaleString()}` : '',
          ),
      h(
        'button',
        {
          class: 'link phone-revoke',
          onclick: () => link.sendPhone({ type: 'phone_revoke', phoneId: p.id }),
        },
        'Revoke',
      ),
    );
  }

  function render(): void {
    toggle.checked = link.phoneOn;
    renderStatus();
    if (!link.phoneOn || !state?.on) {
      body.replaceChildren(
        state && state.phones.length && link.phoneOn
          ? h('ul', { class: 'phones', id: 'phone-list' }, ...state.phones.map(phoneRow))
          : '',
      );
      return;
    }
    const urls = state.urls;
    if (chosenUrl >= urls.length) chosenUrl = 0;
    const url = urls[chosenUrl];
    const priority = select(
      [
        ['webcam', 'This computer’s camera'],
        ['phone', 'The phone'],
      ] as const,
      studio.app.facePriority,
      (v) => studio.setFacePriority(v),
      'When both see your face, use',
    );
    priority.id = 'face-priority';
    body.replaceChildren(
      url
        ? h(
            'div',
            { class: 'phone-connect' },
            h('div', { class: 'phone-qr', id: 'phone-qr' }, qrSvg(url, `QR code of ${url}`)),
            h(
              'ol',
              { class: 'phone-steps' },
              h('li', {}, 'Put the phone on the same network as this computer.'),
              h(
                'li',
                {},
                'Scan the QR code with the phone’s camera, or open this address in its browser: ',
                h('code', { id: 'phone-url' }, url),
                urls.length > 1
                  ? h(
                      'button',
                      {
                        class: 'link',
                        onclick: () => {
                          chosenUrl = (chosenUrl + 1) % urls.length;
                          render();
                        },
                      },
                      ' (another address)',
                    )
                  : '',
              ),
              h(
                'li',
                {},
                'The browser warns that the connection is not private: the certificate is Mochi Studio’s own, made on this computer, so nobody vouches for it. Continue (on an iPhone: Show Details, then visit this website). Its fingerprint begins ',
                h('code', {}, (state.fingerprint ?? '').slice(0, 23)),
                '.',
              ),
              h(
                'li',
                {},
                'Type this pairing code and press «Connect to PC»: ',
                h('strong', { class: 'phone-code', id: 'phone-code' }, state.code ?? ''),
              ),
            ),
          )
        : h(
            'p',
            { class: 'warn' },
            'This computer has no local-network address: connect it to the network the phone uses.',
          ),
      h(
        'label',
        {},
        'When the phone and this computer’s camera both see your face, use ',
        priority,
      ),
      h(
        'p',
        { class: 'hint' },
        'When one loses your face, the other takes over if it is running. Hands always come from this computer’s camera.',
      ),
      state.phones.length
        ? h(
            'div',
            {},
            h('h4', {}, 'Approved phones'),
            h('ul', { class: 'phones', id: 'phone-list' }, ...state.phones.map(phoneRow)),
          )
        : '',
      h(
        'p',
        { class: 'hint' },
        'While this is on, the phone page and its tracking connection listen on port ',
        String(state.port),
        ' of this computer’s network addresses. Nothing else is reachable there. Turn it off to close the port.',
      ),
    );
  }

  link.events.on('state', () => render());
  render();
  return { el, refresh: render };
}

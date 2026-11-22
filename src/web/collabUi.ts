/**
 * The Collab tab (docs/collaboration.md): hosting and joining,
 * the waiting room, the participants, and the settings: the signaling
 * server, the nickname, "Hide my address", and how others get this model.
 */
import { MAX_PEOPLE, MIN_PEOPLE } from '../core/collab/protocol';
import type { CollabStage } from './collab/collabStage';
import { CHAT_MAX_LENGTH, MAX_SHARED_BYTES, type Participant } from './collab/session';
import { h } from './dom';
import { documentLink, HOSTING_TEXT, PRIVACY_TEXT, TERMS_TEXT } from './documents';
import type { Studio } from './studio';

const mb = (n: number) => `${(n / 1024 / 1024).toFixed(n < 10 * 1024 * 1024 ? 1 : 0)} MB`;

export function collabSection(studio: Studio, stage: CollabStage): HTMLElement {
  const box = h('div', { class: 'collab', id: 'collab' });
  const s = stage.session;
  const c = studio.app.collab;
  if (!s || s.status === 'ended') {
    if (s?.message) box.append(h('p', { class: 'hint', id: 'collab-ended' }, s.message));
    box.append(settings(studio, stage), start(studio, stage));
    return box;
  }
  const status =
    s.reconnectingSince !== undefined
      ? 'The connection to the server dropped. Reconnecting (the others still see you)…'
      : s.status === 'connecting'
        ? 'Connecting to the server…'
        : s.status === 'waiting'
          ? 'Waiting for the host to let you in…'
          : s.hostAway
            ? 'The host’s connection dropped. Waiting a minute for it to come back…'
            : s.isHost
              ? `Hosting: ${s.participants.size} of ${c.size} people.`
              : `In the session: ${s.participants.size} people.`;
  box.append(h('p', { id: 'collab-status' }, status));
  if (s.message) box.append(h('p', { class: 'hint' }, s.message));
  // Video costs upload: each other person gets their own copy of it.
  if (stage.sender && s.participants.size > 3)
    box.append(
      h(
        'p',
        { class: 'hint', id: 'collab-video-warning' },
        `Your avatar goes as video to ${s.participants.size - 1} people, which takes a lot of upload (about 2 Mbit/s each). If it stutters, make your avatar smaller on the stage, or share your model’s files with people you trust.`,
      ),
    );
  if (s.isHost && s.link) box.append(invitation(stage), door(stage));
  if (s.participants.size) box.append(people(stage));
  if (s.status === 'hosting' || s.status === 'member') box.append(chat(stage));
  box.append(
    h(
      'div',
      { class: 'row' },
      h(
        'button',
        { id: 'collab-front', onclick: () => s.bringToFront() },
        'Bring my avatar to the front',
      ),
      h(
        'button',
        { id: 'collab-leave', onclick: () => stage.leave() },
        s.isHost ? 'End the session' : 'Leave',
      ),
    ),
  );
  return box;
}

function settings(studio: Studio, stage: CollabStage): HTMLElement {
  const c = studio.app.collab;
  const sharing = studio.settings?.collabSharing ?? 'video';
  return h(
    'div',
    {},
    h(
      'label',
      {},
      'Nickname ',
      h('input', {
        id: 'collab-nickname',
        value: c.nickname,
        maxlength: 40,
        placeholder: 'What the others see',
        onchange: (e: Event) =>
          studio.setCollabSettings({ nickname: (e.target as HTMLInputElement).value.trim() }),
      }),
    ),
    h(
      'label',
      {},
      'Signaling server ',
      h('input', {
        id: 'collab-server',
        value: c.server,
        placeholder: 'wss://…/ws',
        onchange: (e: Event) =>
          studio.setCollabSettings({ server: (e.target as HTMLInputElement).value.trim() }),
      }),
    ),
    h(
      'p',
      { class: 'hint' },
      'What a signaling server sees and keeps: ',
      documentLink('collab-privacy', 'the privacy notice', 'Privacy notice', PRIVACY_TEXT),
      '. Whoever runs the server you choose answers for it.',
    ),
    c.server
      ? ''
      : h(
          'p',
          { class: 'hint', id: 'collab-no-server' },
          'A signaling server address is needed to host: Mochi Studio sets none, and the project runs none. Run your own or use one a friend runs (',
          documentLink('collab-hosting', 'Hosting a server', 'Hosting a server', HOSTING_TEXT),
          '). To join, an invitation link brings its own address; a code needs this setting.',
        ),
    h(
      'label',
      { class: 'check' },
      h('input', {
        type: 'checkbox',
        id: 'collab-hide',
        checked: c.hideAddress,
        onchange: (e: Event) =>
          studio.setCollabSettings({ hideAddress: (e.target as HTMLInputElement).checked }),
      }),
      ' Hide my address (connect through the server’s relay only)',
    ),
    h(
      'label',
      {},
      'My model goes to the others as ',
      h(
        'select',
        {
          id: 'collab-sharing',
          disabled: !studio.settings,
          onchange: (e: Event) => {
            studio.updateSettings({
              collabSharing: (e.target as HTMLSelectElement).value as 'video' | 'shared' | 'never',
            });
            stage.reannounce();
          },
        },
        h('option', { value: 'video', selected: sharing === 'video' }, 'video only (the default)'),
        h(
          'option',
          { value: 'shared', selected: sharing === 'shared' },
          'its files (shared model)',
        ),
        h(
          'option',
          { value: 'never', selected: sharing === 'never' },
          'video only, never its files',
        ),
      ),
    ),
    h(
      'p',
      { class: 'hint' },
      sharing === 'shared'
        ? `Shared: the others’ apps get this model’s files (up to ${mb(MAX_SHARED_BYTES)}), encrypted, and keep them in memory only until you leave. Someone with the right tools could still copy them from memory during the session: share only with people you trust, and never a model whose licence forbids it.`
        : 'Video only: the files never leave this computer. The others get a video of your avatar (about 2 Mbit/s of upload to each of them).',
      ' You are responsible for having the right to use, stream and share what you load: ',
      documentLink('collab-terms', 'the terms', 'Terms of use', TERMS_TEXT),
      '.',
    ),
    stage.sharingNote ? h('p', { class: 'hint' }, stage.sharingNote) : '',
  );
}

function start(studio: Studio, stage: CollabStage): HTMLElement {
  const c = studio.app.collab;
  const link = h('input', {
    id: 'collab-link',
    placeholder: 'An invitation link, or its MOCHI-… code',
  }) as HTMLInputElement;
  const joinPassword = h('input', {
    id: 'collab-join-password',
    type: 'password',
    placeholder: 'Password, if the host set one',
    autocomplete: 'off',
  }) as HTMLInputElement;
  const hostPassword = h('input', {
    id: 'collab-host-password',
    type: 'password',
    placeholder: 'Password (optional)',
    autocomplete: 'off',
  }) as HTMLInputElement;
  const note = h('p', { class: 'hint', id: 'collab-join-note' });
  return h(
    'div',
    {},
    h('h4', {}, 'Host'),
    h(
      'div',
      { class: 'row' },
      h(
        'label',
        {},
        'People ',
        h('input', {
          type: 'number',
          id: 'collab-size',
          min: MIN_PEOPLE,
          max: MAX_PEOPLE,
          value: c.size,
          onchange: (e: Event) =>
            studio.setCollabSettings({ size: Number((e.target as HTMLInputElement).value) }),
        }),
      ),
      h(
        'label',
        {},
        ' Updates a second ',
        h('input', {
          type: 'number',
          id: 'collab-rate',
          min: 10,
          max: 60,
          value: c.rate,
          onchange: (e: Event) =>
            studio.setCollabSettings({ rate: Number((e.target as HTMLInputElement).value) }),
        }),
      ),
      h(
        'button',
        {
          id: 'collab-host',
          disabled: !c.server,
          onclick: () =>
            void stage
              .host(hostPassword.value ? { password: hostPassword.value } : {})
              .catch(() => undefined),
        },
        'Start a session',
      ),
    ),
    h('div', { class: 'row' }, hostPassword),
    h(
      'p',
      { class: 'hint' },
      'A password is a second key: send it apart from the link (say it in a call). It never leaves your computer; people asking to join prove they know it, and a wrong one is declined at once.',
    ),
    h('h4', {}, 'Join'),
    h(
      'div',
      { class: 'row' },
      link,
      joinPassword,
      h(
        'button',
        {
          id: 'collab-join',
          onclick: () => {
            if (!stage.join(link.value, joinPassword.value || undefined))
              note.textContent = 'That isn’t an invitation link or code.';
          },
        },
        'Ask to join',
      ),
    ),
    note,
  );
}

function invitation(stage: CollabStage): HTMLElement {
  const s = stage.session!;
  const link = s.link ?? '';
  const code = s.code ?? '';
  const hidden = '••••••••';
  const field = h('input', {
    id: 'collab-invite',
    readonly: true,
    value: hidden,
    type: 'text',
  }) as HTMLInputElement;
  const codeField = h('input', {
    id: 'collab-code',
    readonly: true,
    value: hidden,
    type: 'text',
  }) as HTMLInputElement;
  let hide: ReturnType<typeof setTimeout> | undefined;
  // Private: shown for 30 seconds, so it doesn't stay on stream.
  const show = (f: HTMLInputElement, v: string) => {
    f.value = v;
    clearTimeout(hide);
    hide = setTimeout(() => {
      field.value = hidden;
      codeField.value = hidden;
    }, 30_000);
  };
  return h(
    'div',
    {},
    h(
      'div',
      { class: 'row' },
      'Invitation ',
      field,
      h('button', { id: 'collab-show', onclick: () => show(field, link) }, 'Show invitation'),
      h(
        'button',
        { id: 'collab-copy', onclick: () => void navigator.clipboard?.writeText(link) },
        'Copy',
      ),
    ),
    h(
      'div',
      { class: 'row' },
      'Code to read aloud ',
      codeField,
      h('button', { id: 'collab-show-code', onclick: () => show(codeField, code) }, 'Show code'),
    ),
    h(
      'div',
      { class: 'row' },
      h(
        'button',
        {
          id: 'collab-new-link',
          title: 'The old link and code stop working; people already in stay.',
          onclick: () => s.newLink(),
        },
        'Make a new link',
      ),
      s.wrongPasswords
        ? h(
            'span',
            { class: 'hint', id: 'collab-wrong-passwords' },
            ` ${s.wrongPasswords} asked with a wrong password and were declined.`,
          )
        : '',
    ),
  );
}

function chat(stage: CollabStage): HTMLElement {
  const s = stage.session!;
  const input = h('input', {
    id: 'collab-chat-input',
    maxlength: CHAT_MAX_LENGTH,
    placeholder: 'Say something to everyone',
    onkeydown: (e: Event) => {
      if ((e as KeyboardEvent).key !== 'Enter') return;
      if (s.sendChat((e.target as HTMLInputElement).value))
        (e.target as HTMLInputElement).value = '';
    },
  }) as HTMLInputElement;
  const time = (at: number) =>
    new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  return h(
    'div',
    { class: 'collab-chat' },
    h('h4', {}, 'Chat'),
    h(
      'ol',
      { id: 'collab-chat', 'aria-live': 'polite' },
      ...s.chat
        .slice(-50)
        .map((m) =>
          h(
            'li',
            { class: m.me ? 'me' : '' },
            h('span', { class: 'hint' }, `${time(m.at)} `),
            h('strong', {}, m.name),
            `: ${m.text}`,
          ),
        ),
    ),
    h(
      'div',
      { class: 'row' },
      input,
      h(
        'button',
        {
          id: 'collab-chat-send',
          onclick: () => {
            if (s.sendChat(input.value)) input.value = '';
          },
        },
        'Send',
      ),
    ),
    h(
      'p',
      { class: 'hint' },
      'Only the people in this session see it, and it is gone when the session ends.',
    ),
  );
}

function door(stage: CollabStage): HTMLElement {
  const s = stage.session!;
  return h(
    'div',
    {},
    h(
      'label',
      { class: 'check' },
      h('input', {
        type: 'checkbox',
        id: 'collab-lock',
        checked: s.locked,
        onchange: (e: Event) => s.lock((e.target as HTMLInputElement).checked),
      }),
      ' Lock: no one else can ask to join',
    ),
    ...[...s.knocks.values()].map((k) =>
      h(
        'div',
        { class: 'row collab-knock', 'data-peer': k.id },
        h('strong', {}, k.valid ? k.name : 'Someone without the invitation'),
        ' asks to join ',
        h(
          'button',
          { class: 'collab-admit', disabled: !k.valid, onclick: () => s.admit(k.id) },
          'Let in',
        ),
        h('button', { class: 'collab-decline', onclick: () => s.decline(k.id) }, 'Decline'),
      ),
    ),
  );
}

function people(stage: CollabStage): HTMLElement {
  const s = stage.session!;
  const row = (p: Participant) => {
    const model = !p.model
      ? 'no model'
      : p.model.mode === 'video'
        ? 'video only'
        : p.files
          ? 'shared model'
          : `shared model, ${mb(p.received)} of ${mb(p.model.bytes)}`;
    return h(
      'li',
      { class: 'collab-person', 'data-peer': p.id },
      h('strong', {}, p.name),
      p.host ? ' (host)' : '',
      p.me ? ' (you)' : '',
      p.me ? '' : h('span', { class: 'hint' }, ` · ${p.connection} · ${model}`),
      p.error ? h('span', { class: 'hint collab-error' }, ` · ${p.error}`) : '',
      p.note ? h('span', { class: 'hint collab-note' }, ` · ${p.note}`) : '',
      p.refusedYours ? h('span', { class: 'hint collab-error' }, ` · ${p.refusedYours}`) : '',
      p.me
        ? ''
        : h(
            'span',
            {},
            h(
              'label',
              {},
              h('input', {
                type: 'checkbox',
                class: 'collab-hide',
                checked: p.hidden,
                onchange: (e: Event) => s.setHidden(p.id, (e.target as HTMLInputElement).checked),
              }),
              ' Hide',
            ),
            h(
              'label',
              {},
              ' Smoothing delay ',
              h('input', {
                type: 'range',
                class: 'collab-delay',
                min: 0,
                max: 1000,
                step: 10,
                value: p.delayMs,
                'aria-label': `Smoothing delay for ${p.name}`,
                onchange: (e: Event) =>
                  s.setDelay(p.id, Number((e.target as HTMLInputElement).value)),
              }),
              ` ${(p.delayMs / 1000).toFixed(2)} s`,
            ),
            h(
              'button',
              {
                class: 'collab-block',
                title:
                  'Hide them and ignore what they send, on your screen only. They aren’t told.',
                onclick: () => s.setBlocked(p.id, !p.blocked),
              },
              p.blocked ? 'Unblock' : 'Block',
            ),
            s.isHost
              ? h('button', { class: 'collab-kick', onclick: () => s.kick(p.id) }, 'Remove')
              : '',
            h('br'),
            h(
              'label',
              {
                title:
                  'On your screen only: their avatar stays where you drag it, not where they stand.',
              },
              h('input', {
                type: 'checkbox',
                class: 'collab-place',
                checked: stage.placedHere.has(p.id),
                onchange: (e: Event) =>
                  stage.placeHere(p.id, (e.target as HTMLInputElement).checked),
              }),
              ' Place them myself',
            ),
            h(
              'label',
              { title: 'Their avatar follows your own model, like an item pinned to it.' },
              h('input', {
                type: 'checkbox',
                class: 'collab-pin',
                checked: stage.placedHere.get(p.id)?.pinned ?? false,
                disabled: !stage.placedHere.has(p.id),
                onchange: (e: Event) =>
                  stage.placeHere(p.id, true, (e.target as HTMLInputElement).checked),
              }),
              ' Pin to my model',
            ),
          ),
      stage.localOrder
        ? h(
            'span',
            { class: 'collab-order' },
            ' ',
            h(
              'button',
              {
                class: 'collab-forward',
                'aria-label': `${p.name} forward`,
                onclick: () => stage.moveInOrder(p.id, 1),
              },
              '▲',
            ),
            h(
              'button',
              {
                class: 'collab-backward',
                'aria-label': `${p.name} back`,
                onclick: () => stage.moveInOrder(p.id, -1),
              },
              '▼',
            ),
          )
        : '',
    );
  };
  // Front first, as on the stage.
  const ids = stage.order().reverse();
  const list = [...s.participants.values()].sort((a, b) => ids.indexOf(a.id) - ids.indexOf(b.id));
  return h(
    'div',
    {},
    h(
      'label',
      { class: 'check', title: 'The order on your screen only; the others keep theirs.' },
      h('input', {
        type: 'checkbox',
        id: 'collab-local-order',
        checked: !!stage.localOrder,
        onchange: (e: Event) =>
          stage.setLocalOrder((e.target as HTMLInputElement).checked ? stage.order() : undefined),
      }),
      ' My own order (front first)',
    ),
    h('ul', { class: 'collab-people', id: 'collab-people' }, ...list.map(row)),
  );
}

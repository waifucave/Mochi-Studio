/**
 * The Audio tab's lipsync type and the advanced lipsync's controls: the
 * type, the model's own mouth shapes
 * (its motion-sync settings), the browser's voice processing, a vowel
 * meter, the automatic vowel mapping, and voice calibration.
 */
import {
  MOUTH_FORM_PARAM,
  profileElements,
  VOICE_ELEMENTS,
  VOICE_INPUT_IDS,
  type VoiceElement,
  DEFAULT_FREQUENCY_WEIGHTS,
  VOWELS,
} from '../core/voice';
import { h, select } from './dom';
import type { Studio } from './studio';

type Notify = (message: string, kind?: 'error') => void;

/** An element with an ID (the DOM helpers' selects take none). */
const withId = <T extends HTMLElement>(el: T, id: string): T => {
  el.id = id;
  return el;
};

const ELEMENT_LABEL: Record<VoiceElement, string> = {
  Silence: 'Silence',
  A: 'A',
  I: 'I',
  U: 'U',
  E: 'E',
  O: 'O',
};

/** What the automatic setup did, for people. */
function setupMessage(done: readonly string[]): string {
  return done.length === 1 && done[0] === MOUTH_FORM_PARAM
    ? 'This model has no vowel parameters: the vowels now shape its mouth form (ParamMouthForm). Turn it off below if you like.'
    : `Mapped the vowels to ${done.join(', ')}.`;
}

export function voicePanel(
  studio: Studio,
  notify: Notify,
): { el: HTMLElement; refresh(): void; live(): void } {
  const el = h('div', { class: 'voice-lipsync' });
  const bars = new Map<VoiceElement, HTMLElement>();
  const meter = h(
    'div',
    { class: 'vowel-meter', id: 'vowel-meter', 'aria-label': 'Vowels heard' },
    ...VOICE_ELEMENTS.map((e) => {
      const bar = h('i');
      bars.set(e, bar);
      return h(
        'div',
        { class: 'vowel', 'data-element': e, title: e === 'Silence' ? 'Silence' : `Vowel ${e}` },
        h('span', {}, e === 'Silence' ? '·' : e),
        h('b', {}, bar),
      );
    }),
  );
  /** The voice being calibrated: the chosen one, or a new name. */
  let calibrating: string | undefined;
  let busy = false;

  const run = (args: Record<string, unknown>): void =>
    void studio.run('set_lip_sync', args).catch((e: Error) => notify(e.message, 'error'));

  /** The weights of the VoiceFrequency input: an approximation. */
  function frequencyWeights(): HTMLElement {
    const w = studio.settings?.lipSync.frequencyWeights ?? DEFAULT_FREQUENCY_WEIGHTS;
    return h(
      'details',
      { class: 'advanced frequency-weights' },
      h('summary', {}, 'Voice frequency (an approximation)'),
      h(
        'p',
        { class: 'hint' },
        'VoiceFrequency is one mouth shape from the vowels, for models with a single mouth-shape parameter. It rests at 0.5; each vowel moves it by its weight times how clearly it is heard, between 0 and 1. VoiceVolumePlusMouthOpen and VoiceFrequencyPlusMouthSmile add the tracked mouth to them.',
      ),
      h(
        'div',
        { class: 'row' },
        ...VOWELS.map((v) =>
          h(
            'label',
            {},
            v,
            h('input', {
              type: 'number',
              class: 'frequency-weight',
              'data-vowel': v,
              min: -1,
              max: 1,
              step: 0.05,
              value: w[v],
              onchange: (e: Event) => {
                const x = Number((e.target as HTMLInputElement).value);
                if (Number.isFinite(x)) run({ frequencyWeights: { [v]: x } });
              },
            }),
          ),
        ),
        h(
          'button',
          {
            class: 'frequency-defaults',
            title: Object.entries(DEFAULT_FREQUENCY_WEIGHTS)
              .map(([k, x]) => `${k} ${x}`)
              .join(', '),
            onclick: () => run({ frequencyWeights: { ...DEFAULT_FREQUENCY_WEIGHTS } }),
          },
          'Defaults',
        ),
      ),
    );
  }

  function calibration(): HTMLElement {
    const voices = studio.voiceProfiles;
    const chosen = studio.voiceProfile;
    const name = calibrating ?? chosen?.name;
    const profile = voices.find((v) => v.name === name);
    const have = new Set(profileElements(profile));
    const newName = h('input', {
      id: 'voice-new-name',
      placeholder: 'A name for a new voice',
      maxlength: 64,
      'aria-label': 'New voice name',
    });
    const record = (e: VoiceElement) =>
      h(
        'button',
        {
          class: `calibrate${have.has(e) ? ' on' : ''}`,
          'data-element': e,
          disabled: !name || busy,
          title:
            e === 'Silence'
              ? 'Records a second of the room while you stay quiet'
              : `Records about a second while you say “${e}”`,
          onclick: async (ev: Event) => {
            if (!name || busy) return;
            busy = true;
            const b = ev.currentTarget as HTMLButtonElement;
            b.textContent = e === 'Silence' ? 'Quiet…' : `Say “${e}”…`;
            try {
              await studio.calibrateVoice(name, e);
              calibrating = undefined;
              notify(
                e === 'Silence'
                  ? `Recorded the room's silence for “${name}”.`
                  : `Recorded “${e}” for “${name}”.`,
              );
            } catch (err) {
              notify((err as Error).message, 'error');
            } finally {
              busy = false;
              refresh();
            }
          },
        },
        `${ELEMENT_LABEL[e]}${have.has(e) ? ' ✓' : ''}`,
      );
    const vowelsDone = ['A', 'I', 'U', 'E', 'O'].every((v) => have.has(v as VoiceElement));
    return h(
      'div',
      { class: 'voice-calibration' },
      h('h3', {}, 'Your voice'),
      h(
        'label',
        {},
        'Voice',
        withId(
          select(
            [
              ['', 'Neutral voice (not calibrated)'],
              ...voices.map((v) => [v.name, v.name] as const),
            ] as const,
            chosen?.name ?? '',
            (v) => {
              calibrating = undefined;
              studio.selectVoice(v || undefined);
              refresh();
            },
            'Voice',
          ),
          'voice-name',
        ),
      ),
      h(
        'div',
        { class: 'row' },
        newName,
        h(
          'button',
          {
            id: 'voice-new',
            onclick: () => {
              const n = newName.value.trim().slice(0, 64);
              if (!n) return notify('Give the new voice a name.', 'error');
              calibrating = n;
              refresh();
            },
          },
          'New voice',
        ),
      ),
      name
        ? h(
            'p',
            { class: 'hint', id: 'voice-status' },
            vowelsDone
              ? `“${name}” knows every vowel${have.has('Silence') ? ' and your room’s silence' : ''}. Record one again to redo it.`
              : `Calibrate “${name}”: press each button and say its vowel for about a second (and stay quiet for Silence). It is used once all five vowels are recorded.`,
          )
        : h(
            'p',
            { class: 'hint', id: 'voice-status' },
            'The neutral voice works for most people. Calibrating your own voice reads the vowels better: choose New voice.',
          ),
      h(
        'div',
        { class: 'row calibrate-row' },
        ...VOICE_ELEMENTS.slice(1).map(record),
        record('Silence'),
      ),
      profile
        ? h(
            'button',
            {
              id: 'voice-delete',
              class: 'danger',
              onclick: () => {
                studio.deleteVoice(profile.name);
                calibrating = undefined;
                refresh();
              },
            },
            `Delete “${profile.name}”`,
          )
        : '',
      h(
        'p',
        { class: 'hint' },
        'A voice is kept in this browser (app-wide), as the vowels’ spectra only: no recording is kept.',
      ),
    );
  }

  function refresh(): void {
    el.replaceChildren();
    const s = studio.settings;
    if (!s) return;
    const ls = s.lipSync;
    el.append(
      h(
        'label',
        {},
        'Lipsync type',
        withId(
          select(
            [
              ['simple', 'Simple (the volume opens the mouth)'],
              ['advanced', 'Advanced (vowels: A, I, U, E, O)'],
            ] as const,
            ls.type,
            (v) => {
              run({ type: v });
              // The lipsync's own automatic setup, the first time: not once the vowels are
              // mapped, or the mouth-form option was decided (by the setup or the person).
              const mapped =
                s.mapping.some((r) => VOICE_INPUT_IDS.has(r.input)) ||
                s.lipSync.vowelForm !== undefined;
              if (v === 'advanced' && !mapped) {
                const done = studio.setUpVowelMapping();
                if (done.length) notify(setupMessage(done));
              }
            },
            'Lipsync type',
          ),
          'lipsync-type',
        ),
      ),
    );
    if (ls.type !== 'advanced') return;
    const shapes = studio.motionSyncSettings;
    el.append(
      h(
        'p',
        { class: 'hint' },
        'Mochi2D’s analysis tells the vowels apart. They are inputs for the mapping (VoiceA … VoiceO, VoiceSilence, VoiceVolume); the volume still opens the mouth.',
      ),
      shapes.length
        ? h(
            'label',
            {},
            'Mouth shapes',
            withId(
              select(
                [
                  ['', 'Vowel inputs, through the mapping'],
                  ...shapes.map(
                    (x) => [x.name || x.id, `The model’s own: “${x.name || x.id}”`] as const,
                  ),
                ] as const,
                ls.motionSync ?? '',
                (v) => run({ motionSync: v }),
                'Mouth shapes',
              ),
              'lipsync-shapes',
            ),
          )
        : '',
      h(
        'label',
        { class: 'check' },
        h('input', {
          type: 'checkbox',
          id: 'voice-processing',
          checked: ls.voiceProcessing,
          onchange: (e: Event) => run({ voiceProcessing: (e.target as HTMLInputElement).checked }),
        }),
        'Browser voice processing (echo cancellation, noise suppression): for noisy rooms',
      ),
      studio.info?.parameters.some((p) => p.id === MOUTH_FORM_PARAM)
        ? h(
            'label',
            { class: 'check' },
            h('input', {
              type: 'checkbox',
              id: 'vowel-form',
              checked: ls.vowelForm === true,
              onchange: (e: Event) => run({ vowelForm: (e.target as HTMLInputElement).checked }),
            }),
            'Vowels shape the mouth: I and E widen it, U and O round it',
          )
        : '',
      frequencyWeights(),
      meter,
      h(
        'div',
        { class: 'row' },
        h(
          'button',
          {
            id: 'vowel-setup',
            title: 'VoiceA … VoiceO to ParamA … ParamO, VoiceSilence to ParamSilence',
            onclick: () => {
              const done = studio.setUpVowelMapping();
              notify(
                done.length
                  ? setupMessage(done)
                  : 'This model has no vowel parameters (ParamA … ParamO, ParamSilence) and no ParamMouthForm. Map the voice inputs yourself in the Model tab.',
                done.length ? undefined : 'error',
              );
            },
          },
          'Set up the vowel mapping',
        ),
      ),
      calibration(),
    );
  }

  /** The meter, from the latest reading. */
  function live(): void {
    const r = studio.voiceReading;
    for (const [e, bar] of bars) bar.style.width = `${Math.round((r?.weights[e] ?? 0) * 100)}%`;
  }

  return { el, refresh, live };
}

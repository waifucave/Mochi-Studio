/**
 * The "Getting started" card above the tabs: the four steps from opening
 * Mochi Studio to a tracked avatar in OBS, each with its action, and what
 * went wrong if a step failed. It shows until the steps are done or the
 * person hides it; the header's Guide button brings it back.
 */
import { guideComplete, guideSteps, type GuideState, type GuideStepId } from '../core/guide';
import { h } from './dom';

export interface GuideActions {
  openFolder(): void;
  openZip(): void;
  /** Loads the sample model that comes with the app. */
  trySample(): void;
  startCamera(): void;
  calibrate(): void;
  /** Shows the Output tab (in a browser, also turns on views through the bridge). */
  setUpOutput(): void;
}

const HIDDEN_KEY = 'mochi-studio.guide';

function storedHidden(): boolean {
  try {
    return localStorage.getItem(HIDDEN_KEY) === 'hidden';
  } catch {
    return false;
  }
}
function storeHidden(hidden: boolean): void {
  try {
    if (hidden) localStorage.setItem(HIDDEN_KEY, 'hidden');
    else localStorage.removeItem(HIDDEN_KEY);
  } catch {
    /* storage unavailable */
  }
}

export class Guide {
  readonly element: HTMLElement;
  /** The header button that shows the card again. */
  readonly toggle: HTMLButtonElement;
  private list: HTMLOListElement;
  private summary: HTMLElement;
  private errors = new Map<GuideStepId, string>();
  private state: GuideState | undefined;
  private hidden = storedHidden();

  constructor(private actions: GuideActions) {
    this.list = h('ol', { class: 'guide-steps' });
    this.summary = h('p', { class: 'guide-summary' });
    this.element = h(
      'section',
      { class: 'guide', id: 'guide', 'aria-label': 'Getting started' },
      h(
        'div',
        { class: 'guide-head' },
        h('h2', {}, 'Getting started'),
        h(
          'button',
          {
            class: 'icon',
            id: 'guide-hide',
            title: 'Hide the guide (the Guide button brings it back)',
            'aria-label': 'Hide the guide',
            onclick: () => this.setHidden(true),
          },
          '×',
        ),
      ),
      this.summary,
      this.list,
    );
    this.toggle = h(
      'button',
      {
        class: 'chip-button',
        id: 'guide-toggle',
        title: 'Show the getting-started guide',
        onclick: () => this.setHidden(!this.hidden),
      },
      'Guide',
    );
    this.element.hidden = this.hidden;
  }

  /** Shows what went wrong in a step (cleared when the step is done or retried). */
  setError(step: GuideStepId, message: string | undefined): void {
    if (message) this.errors.set(step, message);
    else this.errors.delete(step);
    if (this.state) this.render(this.state);
  }

  setHidden(hidden: boolean): void {
    this.hidden = hidden;
    storeHidden(hidden);
    this.element.hidden = hidden;
    this.toggle.setAttribute('aria-pressed', String(!hidden));
  }

  render(state: GuideState): void {
    this.state = state;
    const steps = guideSteps(state);
    for (const s of steps) if (s.status === 'done') this.errors.delete(s.id);
    const done = steps.filter((s) => s.status === 'done').length;
    this.summary.textContent = guideComplete(state)
      ? 'All set: your avatar follows you in OBS. You can hide this guide.'
      : `${done} of ${steps.length} done.`;
    this.toggle.setAttribute('aria-pressed', String(!this.hidden));
    this.list.replaceChildren(
      ...steps.map((s, i) => {
        const error = this.errors.get(s.id);
        return h(
          'li',
          { class: 'guide-step', 'data-step': s.id, 'data-status': s.status },
          h(
            'span',
            { class: 'guide-mark', 'aria-hidden': 'true' },
            s.status === 'done' ? '✓' : String(i + 1),
          ),
          h(
            'div',
            {},
            h(
              'strong',
              {},
              s.title,
              h('span', { class: 'sr-only' }, s.status === 'done' ? ' (done)' : ''),
            ),
            s.status === 'todo' ? '' : h('p', {}, s.detail),
            error ? h('p', { class: 'guide-error', role: 'alert' }, error) : '',
            s.status === 'current' ? this.buttons(s.id, state) : '',
          ),
        );
      }),
    );
  }

  private buttons(id: GuideStepId, state: GuideState): HTMLElement {
    const a = this.actions;
    const b = (label: string, fn: () => void, primary = false) =>
      h('button', { class: primary ? 'primary' : '', onclick: fn }, label);
    const row = h('div', { class: 'row' });
    if (id === 'model')
      row.append(
        b('Open folder…', () => a.openFolder(), true),
        b('Open zip…', () => a.openZip()),
        b('Try the sample model', () => a.trySample()),
      );
    else if (id === 'camera') {
      if (!state.cameraOn) row.append(b('Start camera', () => a.startCamera(), true));
    } else if (id === 'calibrate') row.append(b('Calibrate', () => a.calibrate(), true));
    else
      row.append(
        b(
          state.desktop || state.bridgeReady ? 'Show the OBS address' : 'Set up OBS',
          () => a.setUpOutput(),
          true,
        ),
      );
    return row;
  }
}

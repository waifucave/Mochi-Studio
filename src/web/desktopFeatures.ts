/**
 * The desktop app's additions to the page: recent model folders (offered
 * on the empty stage and in the Model tab, the last one reopened at start)
 * and hotkeys that work while another app has focus.
 */
import {
  globalHotkeyStatus,
  planGlobalHotkeys,
  type GlobalHotkeyPlan,
  type GlobalHotkeyStatus,
  type Platform,
} from '../core/globalHotkeys';
import { comboLabel } from '../core/hotkeys';
import type { ModelFileSet } from '../core/modelFiles';
import { h } from './dom';
import { desktopApi, openRecentFolder, recentProblem, type RecentModel } from './desktopFiles';
import { displayNameFor } from './displayNames';
import type { Studio } from './studio';

interface Deps {
  studio: Studio;
  /** The app's bridge, for reading folders (undefined until connected). */
  diskAccess(): { http: string; token: string } | undefined;
  /** Loads a model the way the Model tab does (with its messages). */
  load(files: Promise<ModelFileSet | undefined>): Promise<void>;
  notify(message: string, kind?: 'info' | 'error'): void;
}

function platform(): Platform {
  const ua = navigator.userAgent;
  return /Mac OS X|Macintosh/.test(ua) ? 'mac' : /Windows/.test(ua) ? 'windows' : 'linux';
}

// ---------------------------------------------------------------------------
// Recent models

export class RecentModelsUi {
  /** For the Model tab. */
  readonly panel: HTMLElement;
  /** For the empty stage. */
  readonly stageList: HTMLElement;
  /** For the model selection bar: every recent model. */
  readonly bar: HTMLElement;
  private list: RecentModel[] = [];

  constructor(private d: Deps) {
    this.panel = h('div', { class: 'recent', id: 'recent-models' });
    this.stageList = h('div', { class: 'recent stage-recent', id: 'stage-recent' });
    this.bar = h('ul', { class: 'recent model-bar-recent', id: 'model-bar-recent' });
    d.studio.events.on('modelLoaded', () => void this.refresh());
    d.studio.events.on('appSettingsChanged', () => this.render());
  }

  async refresh(): Promise<void> {
    this.list = (await desktopApi()?.recentModels()) ?? [];
    this.render();
  }

  /** Reopens the newest folder if the setting is on (at start). */
  async reopenLast(): Promise<void> {
    await this.d.studio.ready;
    await this.refresh();
    const last = this.list[0];
    if (!last || !this.d.studio.app.reopenLastModel || this.d.studio.model) return;
    if (last.state !== 'ok') {
      this.d.notify(recentProblem(last, last.state), 'error');
      return;
    }
    await this.open(last);
  }

  private async open(r: RecentModel): Promise<void> {
    const disk = this.d.diskAccess();
    if (!disk) return this.d.notify('The app’s bridge is not connected yet; try again.', 'error');
    await this.d.load(openRecentFolder(r, disk.http, disk.token));
    await this.refresh();
  }

  private async forget(r: RecentModel): Promise<void> {
    this.list = (await desktopApi()?.forgetRecent(r.path)) ?? [];
    this.render();
  }

  private item(r: RecentModel, withForget: boolean): HTMLElement {
    const problem = r.state !== 'ok';
    return h(
      'li',
      { class: 'recent-item', 'data-state': r.state },
      h(
        'button',
        {
          class: 'recent-open',
          title: r.path,
          onclick: () =>
            problem
              ? this.d.notify(recentProblem(r, r.state), 'error')
              : void this.open(r).catch((e) => this.d.notify((e as Error).message, 'error')),
        },
        h('strong', {}, displayNameFor(r.path) ?? r.label),
        h('span', { class: 'hint' }, problem ? ' — moved or gone' : ''),
      ),
      withForget
        ? h(
            'button',
            {
              class: 'icon',
              title: 'Remove from the list (the folder or zip is not touched)',
              'aria-label': `Remove ${displayNameFor(r.path) ?? r.label} from the list`,
              onclick: () => void this.forget(r),
            },
            '×',
          )
        : '',
      withForget ? h('div', { class: 'hint recent-path' }, r.path) : '',
    );
  }

  private render(): void {
    const s = this.d.studio;
    this.panel.replaceChildren(
      h('h3', {}, 'Recent models'),
      this.list.length
        ? h(
            'ul',
            {},
            this.list.map((r) => this.item(r, true)),
          )
        : h(
            'p',
            { class: 'hint' },
            'Folders and zips you open with Open folder… and Open zip… appear here.',
          ),
      h(
        'label',
        { class: 'check' },
        h('input', {
          type: 'checkbox',
          id: 'reopen-last',
          checked: s.app.reopenLastModel,
          onchange: (e: Event) =>
            s.setAppOptions({ reopenLastModel: (e.target as HTMLInputElement).checked }),
        }),
        'Reopen the last model when the app starts',
      ),
    );
    this.bar.replaceChildren(...this.list.map((r) => this.item(r, false)));
    const top = this.list.slice(0, 5);
    this.stageList.replaceChildren(
      ...(top.length
        ? [
            h('p', { class: 'hint' }, 'Recent:'),
            h(
              'ul',
              {},
              top.map((r) => this.item(r, false)),
            ),
          ]
        : []),
    );
  }
}

// ---------------------------------------------------------------------------
// Global hotkeys

export class GlobalHotkeysUi {
  readonly panel: HTMLElement;
  private plans = new Map<string, GlobalHotkeyPlan>();
  private status: GlobalHotkeyStatus[] = [];
  private sent = '';
  private platform = platform();

  constructor(private d: Deps) {
    this.panel = h('div', { class: 'global-hotkeys', id: 'global-hotkeys' });
    const api = desktopApi();
    api?.onGlobalHotkey((a) => this.fire(a));
    const update = (): void => void this.sync();
    d.studio.events.on('modelLoaded', update);
    d.studio.events.on('modelUnloaded', update);
    d.studio.events.on('settingsChanged', update);
    d.studio.events.on('appSettingsChanged', update);
  }

  /** Whether a hotkey is registered with the system (the window's own key handler then skips it). */
  isGlobal = (id: string): boolean => this.status.some((s) => s.id === id && s.global);

  private fire(accelerator: string): void {
    const s = this.d.studio;
    for (const st of this.status)
      if (st.global && st.accelerator === accelerator)
        void s.run('fire_hotkey', { id: st.id }).catch(() => undefined);
  }

  /** Registers what can be global (when on), and shows each hotkey's status. */
  async sync(): Promise<void> {
    const s = this.d.studio;
    const on = s.app.globalHotkeys;
    const { accelerators, plans } = planGlobalHotkeys(s.settings?.hotkeys ?? [], this.platform);
    this.plans = plans;
    const wanted = on ? accelerators : [];
    const key = JSON.stringify(wanted);
    let registered = new Map<string, boolean>(
      this.status.flatMap((x) => (x.accelerator ? [[x.accelerator, x.global] as const] : [])),
    );
    if (key !== this.sent) {
      this.sent = key;
      const r = (await desktopApi()?.setGlobalHotkeys(wanted)) ?? {};
      registered = new Map(Object.entries(r));
    }
    this.status = on ? globalHotkeyStatus(plans, registered) : [];
    this.render();
  }

  private render(): void {
    const s = this.d.studio;
    const hotkeys = s.settings?.hotkeys ?? [];
    const label = (id: string): string => {
      const hk = hotkeys.find((x) => x.id === id);
      return hk
        ? `${hk.keys ? comboLabel(hk.keys) : '(no keys)'}${hk.label ? ` · ${hk.label}` : ''}`
        : id;
    };
    this.panel.replaceChildren(
      h(
        'label',
        { class: 'check' },
        h('input', {
          type: 'checkbox',
          id: 'global-hotkeys-toggle',
          checked: s.app.globalHotkeys,
          onchange: (e: Event) =>
            s.setAppOptions({ globalHotkeys: (e.target as HTMLInputElement).checked }),
        }),
        'Hotkeys also work while another app (a game, OBS) has focus',
      ),
      s.app.globalHotkeys && this.status.length
        ? h(
            'ul',
            { class: 'global-status' },
            this.status.map((st) =>
              h(
                'li',
                { 'data-global': String(st.global), 'data-hotkey': st.id },
                h('strong', {}, label(st.id)),
                st.global
                  ? h('span', { class: 'ok' }, ' — works in other apps')
                  : h('span', { class: 'hint' }, ` — only in this window: ${st.reason}`),
              ),
            ),
          )
        : '',
    );
  }
}

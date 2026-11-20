/**
 * Where the mouse pointer is, for the mouse inputs (5.1;
 * src/core/mouseInput.ts): in a browser, over the page; in the desktop app,
 * anywhere on the screen (the app's main process reads it, about 60 times a
 * second, measured from the main screen).
 */
import { mouseInputs, type MouseRange, type PointerSample } from '../core/mouseInput';
import type { InputValues } from '../core/tracking';
import { desktopApi, type DesktopScreen } from './desktopFiles';

export class PointerInput {
  private last: PointerSample | undefined;
  /** Where the samples come from: the screen (the desktop app) or the page. */
  readonly scope: 'screen' | 'page';

  constructor() {
    const desk = typeof window === 'undefined' ? undefined : desktopApi();
    if (desk?.watchPointer) {
      this.scope = 'screen';
      desk.watchPointer((p) => {
        this.last = p;
      });
    } else {
      this.scope = 'page';
      if (typeof window !== 'undefined')
        addEventListener(
          'pointermove',
          (e) => {
            this.last = {
              x: e.clientX,
              y: e.clientY,
              area: { x: 0, y: 0, width: innerWidth, height: innerHeight },
            };
          },
          { passive: true, capture: true },
        );
    }
  }

  /** The desktop app's screens (none in a browser). */
  async screens(): Promise<DesktopScreen[]> {
    return (await desktopApi()?.listScreens?.()) ?? [];
  }

  /** In the desktop app: the screen the ranges are centred on (undefined: the main one). */
  setScreen(id: number | undefined): void {
    void desktopApi()?.setPointerScreen?.(id ?? null);
  }

  /** The mouse inputs, once the pointer has been seen; none before. */
  values(range: MouseRange): InputValues {
    return this.last ? mouseInputs(this.last, range) : {};
  }
}

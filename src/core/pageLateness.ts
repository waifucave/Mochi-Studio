/**
 * How late a page's own timers run: its event loop, which handles the person's clicks and keys
 * and draws its frames. The desktop app's probe (desktop/windowProbe.ts) times the window from
 * the main process, so a main process that is busy makes the window look slow too; this is the
 * window's own measure, kept per second for the last two minutes.
 */
export const LATENESS_EVERY_MS = 250;
const KEEP_SECONDS = 120;

export class PageLateness {
  /** [the second's start (wall-clock ms), the latest a timer came in it (ms)], oldest first. */
  readonly seconds: Array<[number, number]> = [];
  private last: number | undefined;

  /** A timer set every LATENESS_EVERY_MS ran: `now` its monotonic time, `wall` the clock's. */
  tick(now: number, wall: number): void {
    const late = this.last === undefined ? 0 : Math.max(0, now - this.last - LATENESS_EVERY_MS);
    this.last = now;
    const second = Math.floor(wall / 1000) * 1000;
    const tail = this.seconds.at(-1);
    if (tail && tail[0] === second) tail[1] = Math.max(tail[1], Math.round(late));
    else this.seconds.push([second, Math.round(late)]);
    while (this.seconds.length > KEEP_SECONDS) this.seconds.shift();
  }

  /** The latest a timer came between two wall-clock times (ms), and how many seconds had one. */
  between(from: number, to: number): { worstMs: number; seconds: number } {
    const s = this.seconds.filter(([t]) => t + 1000 > from && t <= to);
    return { worstMs: Math.max(0, ...s.map(([, ms]) => ms)), seconds: s.length };
  }

  /** Runs the timer (in a page). */
  start(): () => void {
    const id = setInterval(() => this.tick(performance.now(), Date.now()), LATENESS_EVERY_MS);
    return () => clearInterval(id);
  }
}

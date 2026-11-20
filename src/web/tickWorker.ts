/**
 * A steady clock for the control window's frame loop (src/web/frameClock.ts).
 * Browsers stop a hidden or minimized page's animation frames and slow its
 * own timers to about once a second, but a dedicated worker's timer keeps
 * its pace; its ticks keep output views fed while the window is out of
 * sight.
 */
let timer: ReturnType<typeof setInterval> | undefined;

self.onmessage = (e: MessageEvent<{ interval: number }>) => {
  clearInterval(timer);
  timer = undefined;
  const ms = e.data.interval;
  if (ms > 0) timer = setInterval(() => self.postMessage(0), ms);
};

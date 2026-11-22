import { readdirSync, readFileSync } from 'node:fs';
import type { Page } from 'playwright-core';

/**
 * Memory of a browser's processes (Linux, from /proc) and of a page's
 * JavaScript (its heap and ArrayBuffer backing stores), for measurements.
 */
/** The processes under a pid (Linux). */
export function descendants(root: number): number[] {
  const parent = new Map<number, number>();
  for (const d of readdirSync('/proc')) {
    if (!/^\d+$/.test(d)) continue;
    try {
      const stat = readFileSync(`/proc/${d}/stat`, 'utf8');
      parent.set(Number(d), Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[1]));
    } catch {
      // gone
    }
  }
  const out: number[] = [];
  const walk = (p: number) => {
    for (const [c, pp] of parent) if (pp === p) (out.push(c), walk(c));
  };
  walk(root);
  return out;
}

/** The receiver's renderer: the child of its browser with `--type=renderer` and the most memory. */
export function processMemory(browserPid: number): {
  rendererRss: number;
  rendererPeak: number;
  allRss: number;
} {
  let rendererRss = 0;
  let rendererPeak = 0;
  let allRss = 0;
  for (const pid of [browserPid, ...descendants(browserPid)]) {
    try {
      const status = readFileSync(`/proc/${pid}/status`, 'utf8');
      const kb = (k: string) => Number(new RegExp(`${k}:\\s+(\\d+)`).exec(status)?.[1] ?? 0) * 1024;
      allRss += kb('VmRSS');
      const cmd = readFileSync(`/proc/${pid}/cmdline`, 'utf8');
      if (cmd.includes('--type=renderer') && kb('VmHWM') > rendererPeak) {
        rendererPeak = kb('VmHWM');
        rendererRss = kb('VmRSS');
      }
    } catch {
      // gone
    }
  }
  return { rendererRss, rendererPeak, allRss };
}

/** A page's JS heap plus ArrayBuffer backing stores, in bytes (Chromium's CDP). */
export async function heapOf(page: Page): Promise<() => Promise<number>> {
  const cdp = await page.context().newCDPSession(page);
  return async () => {
    const h = (await cdp.send('Runtime.getHeapUsage')) as {
      usedSize: number;
      backingStorageSize?: number;
      embedderHeapUsedSize?: number;
    };
    return h.usedSize + (h.backingStorageSize ?? 0) + (h.embedderHeapUsedSize ?? 0);
  };
}

/** CPU time used so far by a browser and all its processes, in seconds (Linux, /proc). */
export function cpuSeconds(browserPid: number): number {
  let ticks = 0;
  for (const pid of [browserPid, ...descendants(browserPid)]) {
    try {
      const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
      const f = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
      ticks += Number(f[11]) + Number(f[12]);
    } catch {
      // gone
    }
  }
  return ticks / 100;
}

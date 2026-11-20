/**
 * Uploads files for output views to the bridge, off the page's main
 * thread: the control window may be busy loading and drawing a large model,
 * and every step of an upload on the main thread would wait for it.
 *
 * Messages in: `config` (bridge address and host token), `add` (files as
 * Blobs, in order), `first` (a view is waiting for this one), `clear`.
 * Messages out: `done` per file, with the bytes sent or skipped.
 */
interface Job {
  rel: string;
  blob: Blob;
}
type In =
  | { type: 'config'; base: string; token: string }
  | { type: 'add'; jobs: Job[] }
  | { type: 'first'; rel: string }
  | { type: 'clear' };

let base = '';
let token = '';
let queue: Job[] = [];
let busy = false;

const post = (m: unknown): void => (self as unknown as Worker).postMessage(m);

async function run(): Promise<void> {
  if (busy) return;
  busy = true;
  while (queue.length) {
    const job = queue.shift()!;
    const url = `${base}/upload/${job.rel}`;
    const headers = { authorization: `Bearer ${token}` };
    try {
      const have = await fetch(url, { method: 'HEAD', headers });
      if (have.ok && Number(have.headers.get('content-length')) === job.blob.size) {
        post({ type: 'done', rel: job.rel, ok: true, skipped: job.blob.size, sent: 0 });
        continue;
      }
      const r = await fetch(url, { method: 'PUT', headers, body: job.blob });
      post({ type: 'done', rel: job.rel, ok: r.ok, skipped: 0, sent: r.ok ? job.blob.size : 0 });
    } catch {
      post({ type: 'done', rel: job.rel, ok: false, skipped: 0, sent: 0 });
    }
  }
  busy = false;
}

self.onmessage = (e: MessageEvent<In>) => {
  const m = e.data;
  if (m.type === 'config') {
    base = m.base;
    token = m.token;
  } else if (m.type === 'add') {
    queue.push(...m.jobs);
    void run();
  } else if (m.type === 'first') {
    const i = queue.findIndex((j) => j.rel === m.rel);
    if (i > 0) queue.unshift(...queue.splice(i, 1));
  } else if (m.type === 'clear') queue = [];
};

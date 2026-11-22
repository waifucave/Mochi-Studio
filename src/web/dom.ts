type Attrs = Record<string, string | number | boolean | undefined | ((e: Event) => void)>;
type Child = Node | string | false | null | undefined;

/** Tiny element builder: h('button', { class: 'x', onclick: fn }, 'Label'). */
export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Attrs = {},
  ...children: Array<Child | Child[]>
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === false) continue;
    if (typeof v === 'function') el.addEventListener(k.replace(/^on/, ''), v);
    else if (k === 'value' && 'value' in el) (el as HTMLInputElement).value = String(v);
    else if (k === 'checked' && 'checked' in el) (el as HTMLInputElement).checked = !!v;
    else el.setAttribute(k, v === true ? '' : String(v));
  }
  for (const c of children.flat()) if (c !== false && c !== null && c !== undefined) el.append(c);
  return el;
}

export function numberInput(
  value: number,
  onChange: (v: number) => void,
  opts: { step?: number; min?: number; max?: number; label?: string; id?: string } = {},
): HTMLInputElement {
  return h('input', {
    type: 'number',
    ...(opts.id ? { id: opts.id } : {}),
    value,
    step: opts.step ?? 'any',
    min: opts.min,
    max: opts.max,
    'aria-label': opts.label,
    onchange: (e: Event) => {
      const v = Number((e.target as HTMLInputElement).value);
      if (Number.isFinite(v)) onChange(v);
    },
  });
}

export function select<T extends string>(
  options: ReadonlyArray<readonly [T, string]>,
  value: string,
  onChange: (v: T) => void,
  label?: string,
): HTMLSelectElement {
  return h(
    'select',
    {
      'aria-label': label,
      onchange: (e: Event) => onChange((e.target as HTMLSelectElement).value as T),
    },
    ...options.map(([v, l]) => h('option', { value: v, selected: v === value }, l)),
  );
}

export function downloadText(
  name: string,
  text: string | Uint8Array<ArrayBuffer>,
  type = 'application/json',
): void {
  const a = h('a', {
    href: URL.createObjectURL(new Blob([text], { type })),
    download: name,
  });
  a.hidden = true;
  document.body.append(a);
  a.click();
  setTimeout(() => {
    a.remove();
    URL.revokeObjectURL(a.href);
  }, 1000);
}

/** Lets the user pick a file and returns its bytes. */
/** A chosen file refused for its size, with a message for people. */
export class FileTooLargeError extends Error {}

/**
 * A file the person chooses, as bytes. One larger than `max` is refused
 * (the promise rejects with `tooLarge`'s message) before it is read.
 */
export function readFileBytes(
  accept: string,
  max = Infinity,
  tooLarge: (size: number) => string = () => 'The file is too large.',
): Promise<Uint8Array | undefined> {
  return new Promise((res, rej) => {
    const input = h('input', { type: 'file', accept });
    input.addEventListener('change', () => {
      const f = input.files?.[0];
      if (!f) return res(undefined);
      if (f.size > max) return rej(new FileTooLargeError(tooLarge(f.size)));
      void f.arrayBuffer().then((b) => res(new Uint8Array(b)), rej);
    });
    input.click();
  });
}

/** As `readFileBytes`, as text. */
export function readFileText(
  accept: string,
  max = Infinity,
  tooLarge: (size: number) => string = () => 'The file is too large.',
): Promise<string | undefined> {
  return new Promise((res, rej) => {
    const input = h('input', { type: 'file', accept });
    input.addEventListener('change', () => {
      const f = input.files?.[0];
      if (!f) return res(undefined);
      if (f.size > max) return rej(new FileTooLargeError(tooLarge(f.size)));
      void f.text().then(res, rej);
    });
    input.click();
  });
}

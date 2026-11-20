/**
 * Display names of models by their folder or zip path (the desktop app), so
 * the recent list and plugins can show a model's name while another one is
 * loaded. The name itself lives in the model's settings (`displayName`).
 */
const KEY = 'mochi-studio.displayNames';

function read(): Record<string, string> {
  try {
    const v: unknown = JSON.parse(localStorage.getItem(KEY) ?? '{}');
    return v && typeof v === 'object' ? (v as Record<string, string>) : {};
  } catch {
    return {};
  }
}

export function displayNameFor(path: string): string | undefined {
  const n = read()[path];
  return typeof n === 'string' && n ? n : undefined;
}

export function rememberDisplayName(path: string, name: string | undefined): void {
  const all = read();
  if (name) all[path] = name;
  else delete all[path];
  try {
    localStorage.setItem(KEY, JSON.stringify(all));
  } catch {
    /* storage unavailable */
  }
}

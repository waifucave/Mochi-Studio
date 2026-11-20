export type Background =
  | { kind: 'transparent' }
  | { kind: 'chroma'; color: string }
  | { kind: 'color'; color: string }
  /** `src` is a data: URL, so the setting survives export and import. */
  | { kind: 'image'; src: string; fit: 'cover' | 'contain' };

export const DEFAULT_BACKGROUND: Background = { kind: 'transparent' };
export const CHROMA_PRESETS = { green: '#00ff00', blue: '#0000ff', magenta: '#ff00ff' } as const;

const HEX = /^#[0-9a-f]{6}$/i;
export function isHexColor(s: unknown): s is string {
  return typeof s === 'string' && HEX.test(s);
}

/** CSS declarations for the output view's background layer. */
export function backgroundCss(b: Background): Record<string, string> {
  switch (b.kind) {
    case 'transparent':
      return { background: 'transparent' };
    case 'chroma':
    case 'color':
      return { background: b.color };
    case 'image':
      return {
        'background-color': 'transparent',
        'background-image': `url("${b.src.replace(/"/g, '%22')}")`,
        'background-size': b.fit,
        'background-position': 'center',
        'background-repeat': 'no-repeat',
      };
  }
}

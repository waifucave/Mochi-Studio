import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/** The app's icon: one hand-drawn SVG, from which the build makes every other form. */
const root = new URL('../../', import.meta.url);
const read = (p: string) => readFileSync(new URL(p, root), 'utf8');

describe("the app's icon", () => {
  const svg = read('public/icon.svg');

  it('is plain shapes: no text, fonts, images or links to other files', () => {
    expect(svg).not.toMatch(/<(text|tspan|image|use|font|style|script|foreignObject)\b/);
    expect(svg).not.toMatch(/href=|url\(|font-family/);
    expect(svg).toMatch(/viewBox="0 0 1024 1024"/);
  });

  it('is in every package and page, from that one file', () => {
    const builder = JSON.parse(read('desktop/electron-builder.json'));
    for (const os of ['linux', 'win', 'mac']) expect(builder[os].icon).toBe('dist/build/icon.png');
    expect(builder.files).toContain('icon.png');
    const build = read('desktop/build.mjs');
    expect(build).toContain("here('../public/icon.svg')");
    expect(build).toContain("toFile(here('./dist/build/icon.png'))");
    expect(read('desktop/main.ts')).toContain("icon: join(__dirname, 'icon.png')");
    for (const page of ['index.html', 'output.html', 'phone.html'])
      expect(read(page)).toContain('<link rel="icon" type="image/svg+xml" href="./icon.svg" />');
    expect(read('.github/workflows/desktop.yml')).toContain('default Electron icon is used');
  });

  it('is named in the notices as the project’s own', () => {
    expect(read('THIRD_PARTY_NOTICES.md')).toContain("**The app's icon** (`public/icon.svg`");
  });
});

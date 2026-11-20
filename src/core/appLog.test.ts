import { describe, expect, it } from 'vitest';
import { AppLog, LOG_LIMIT, bugReport, guard, scrub } from './appLog';

describe('the app log', () => {
  it('keeps personal data out', () => {
    expect(scrub('Could not read /Users/alice/Models/Hiyori/x.moc3')).toBe(
      'Could not read /Users/…/Models/Hiyori/x.moc3',
    );
    expect(scrub('C:\\Users\\Bob Smith\\Desktop\\m.zip')).toBe('C:\\Users\\…\\Desktop\\m.zip');
    expect(scrub('/home/carol/x')).toBe('/home/…/x');
    expect(scrub('mail me at someone@example.org')).toBe('mail me at [e-mail]');
    expect(scrub('phone at 192.168.1.20:27890, bridge 127.0.0.1:47830')).toBe(
      'phone at [address]:27890, bridge 127.0.0.1:47830',
    );
    expect(scrub('http://127.0.0.1:47830/app/output.html?bridge=ws%3A%2F%2Fx&view=k3y#t')).toBe(
      'http://127.0.0.1:47830/app/output.html?…',
    );
    expect(scrub('token 0123456789abcdef0123456789abcdef refused')).toBe('token [id] refused');
    expect(scrub(`image data:image/png;base64,${'iVBORw0KGgo'.repeat(30)} end`)).toBe(
      'image [data] end',
    );
    expect(scrub(`raw ${'A'.repeat(300)}`)).toBe('raw [data]');
    // Ordinary words and names stay.
    expect(scrub('Loaded DeepSeek: 23 expressions, ParamAngleX at 30')).toBe(
      'Loaded DeepSeek: 23 expressions, ParamAngleX at 30',
    );
    expect(scrub('x'.repeat(5000)).length).toBeLessThan(2100);
  });

  it('folds repeats into one entry, and keeps the newest', () => {
    let now = 0;
    const log = new AppLog(() => now);
    expect(log.add('Frame: boom', 'error')).toBe(true);
    now += 16;
    expect(log.add('Frame: boom', 'error')).toBe(false);
    expect(log.entries).toHaveLength(1);
    expect(log.entries[0]!.count).toBe(2);
    // Two errors every frame, interleaved: still two entries.
    log.add('Light: bang', 'error');
    log.add('Frame: boom', 'error');
    log.add('Light: bang', 'error');
    expect(log.entries.map((e) => [e.text, e.count])).toEqual([
      ['Frame: boom', 3],
      ['Light: bang', 2],
    ]);
    now += 120_000;
    expect(log.add('Frame: boom', 'error')).toBe(true);
    for (let i = 0; i < LOG_LIMIT + 10; i++) log.add(`m${i}`);
    expect(log.entries).toHaveLength(LOG_LIMIT);
    expect(log.entries.at(-1)!.text).toBe(`m${LOG_LIMIT + 9}`);
  });

  it('runs a frame step guarded, and saves a report', () => {
    const log = new AppLog(() => 0);
    const out = guard(
      (w, e) => log.error(w, e),
      'The light',
      () => {
        throw new Error('no capture at /home/dave/x');
      },
    );
    expect(out).toBeUndefined();
    expect(
      guard(
        () => undefined,
        'ok',
        () => 5,
      ),
    ).toBe(5);
    const r = bugReport(log, {
      version: '0.1.0',
      userAgent: 'Mozilla/5.0 (X11; Linux x86_64) Chrome/140',
      desktop: false,
      facts: { model: 'loaded', items: 2 },
    });
    expect(r).toContain('Version: 0.1.0');
    expect(r).toContain('items: 2');
    expect(r).toContain('error The light: no capture at /home/…/x');
    expect(r).not.toContain('dave');
  });
});

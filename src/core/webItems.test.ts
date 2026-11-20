import { describe, expect, it } from 'vitest';
import { bgraToRgba, isOwnAddress, parseWebItem, webItemUrl } from './webItems';
import { parseItems } from './items';

describe('web items', () => {
  it('takes only http and https addresses', () => {
    expect(webItemUrl('https://example.com/chat')).toBe('https://example.com/chat');
    expect(webItemUrl(' http://127.0.0.1:8080 ')).toBe('http://127.0.0.1:8080/');
    for (const bad of ['file:///etc/passwd', 'javascript:alert(1)', 'data:text/html,x', 'nope', 42])
      expect(webItemUrl(bad), String(bad)).toBeUndefined();
  });

  it('reads stored sources safely, and keeps them with the item', () => {
    expect(parseWebItem({ url: 'https://a.b/', width: 9999, height: 2, fps: 99 })).toEqual({
      url: 'https://a.b/',
      width: 1920,
      height: 16,
      fps: 30,
    });
    expect(parseWebItem({ url: 'ftp://a.b/' })).toBeUndefined();
    const [item] = parseItems([
      { id: 'w', label: 'Chat', visible: true, pinned: false, web: { url: 'https://a.b/' } },
    ]);
    expect(item!.web).toEqual({ url: 'https://a.b/', width: 640, height: 360, fps: 10 });
  });

  it('knows Mochi Studio’s own addresses, on every loopback name', () => {
    const own = ['http://127.0.0.1:47900', 'https://127.0.0.1:27890'];
    expect(isOwnAddress('http://127.0.0.1:47900/app/', own)).toBe(true);
    expect(isOwnAddress('http://localhost:47900/api', own)).toBe(true);
    expect(isOwnAddress('https://[::1]:27890/', own)).toBe(true);
    expect(isOwnAddress('http://127.0.0.2:47900/', own)).toBe(true);
    expect(isOwnAddress('http://0.0.0.0:47900/', own)).toBe(true);
    expect(isOwnAddress('http://2130706433:47900/', own)).toBe(true);
    expect(isOwnAddress('http://app.localhost:47900/', own)).toBe(true);
    expect(isOwnAddress('https://[::ffff:127.0.0.1]:27890/', own)).toBe(true);
    expect(isOwnAddress('ws://localhost:47900/ws', own)).toBe(true);
    // The computer's own network address, where the phone page listens.
    expect(isOwnAddress('https://192.168.1.20:27890/', own, ['192.168.1.20'])).toBe(true);
    expect(isOwnAddress('https://192.168.1.21:27890/', own, ['192.168.1.20'])).toBe(false);
    expect(isOwnAddress('http://127.0.0.1:8080/', own)).toBe(false);
    expect(isOwnAddress('https://example.com/', own)).toBe(false);
  });

  it('turns Electron’s BGRA frames into RGBA', () => {
    expect([...bgraToRgba(Uint8Array.from([1, 2, 3, 4, 5, 6, 7, 8]))]).toEqual([
      3, 2, 1, 4, 7, 6, 5, 8,
    ]);
  });
});

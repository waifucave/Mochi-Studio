import { describe, expect, it } from 'vitest';
import {
  decryptBytes,
  decryptText,
  encryptBytes,
  encryptText,
  invitationCode,
  invitationLink,
  newDoor,
  newSecret,
  passwordProof,
  parseInvitation,
  sessionKeys,
} from './crypto';
import {
  decodeParams,
  dequantize,
  encodeParams,
  ParamSender,
  quantize,
  RemoteParams,
  type ParamInfo,
} from './state';

describe('the session’s secret and keys', () => {
  it('makes and reads invitation links, with the secret and the door after #', () => {
    const secret = newSecret();
    const door = newDoor();
    expect(secret).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(door).toMatch(/^[A-Za-z0-9_-]{8}$/);
    const link = invitationLink('wss://collab.example/ws', 'a1b2c3', secret, door);
    expect(link).toBe(`https://collab.example/join/a1b2c3#${secret}.${door}`);
    expect(parseInvitation(link)).toEqual({
      server: 'wss://collab.example/ws',
      room: 'a1b2c3',
      secret,
      door,
    });
    const local = invitationLink('ws://127.0.0.1:8790/ws', 'ff', secret, door);
    expect(parseInvitation(local)?.server).toBe('ws://127.0.0.1:8790/ws');
    for (const bad of [
      '',
      'nonsense',
      'https://x/join/zz#short',
      `https://x/other/ab#${secret}.${door}`,
      `https://x/join/ab#${secret}`,
    ])
      expect(parseInvitation(bad), bad).toBeUndefined();
  });

  it('writes the whole invitation as a code to read aloud, forgiving case, dashes and look-alikes', () => {
    const room = 'c0ffee1234567890ab';
    const secret = newSecret();
    const door = newDoor();
    const code = invitationCode(room, secret, door)!;
    expect(code).toMatch(/^MOCHI(-[0-9A-HJKMNP-TV-Z]{5}){10}$/);
    expect(parseInvitation(code)).toEqual({ room, secret, door });
    // Typed by a person: lower case, spaces for dashes, O for 0 and l for 1.
    const typed = code.toLowerCase().replace(/-/g, ' ').replace(/0/g, 'o').replace(/1/g, 'l');
    expect(parseInvitation(typed)).toEqual({ room, secret, door });
    expect(parseInvitation(code.slice(0, -1))).toBeUndefined();
  });

  it('proves a room password without giving it away', async () => {
    const a = await passwordProof('hunter2', 'room1');
    expect(a).not.toContain('hunter2');
    expect(await passwordProof('hunter2', 'room1')).toBe(a);
    expect(await passwordProof('hunter3', 'room1')).not.toBe(a);
    expect(await passwordProof('hunter2', 'room2')).not.toBe(a);
  });

  it('encrypts names and files so only the same secret and room read them', async () => {
    const secret = newSecret();
    const k = await sessionKeys(secret, 'room1');
    const name = await encryptText(k.names, 'Momo 🍡');
    expect(name).not.toContain('Momo');
    expect(await decryptText(k.names, name)).toBe('Momo 🍡');
    // Another room, another secret, or the files key: unreadable.
    expect(await decryptText((await sessionKeys(secret, 'room2')).names, name)).toBeUndefined();
    expect(
      await decryptText((await sessionKeys(newSecret(), 'room1')).names, name),
    ).toBeUndefined();
    expect(await decryptText(k.files, name)).toBeUndefined();
    const data = new Uint8Array(1000).map((_, i) => i % 251);
    const aad = new TextEncoder().encode('model.moc3#0');
    const enc = await encryptBytes(k.files, data, aad);
    expect(enc.length).toBe(1000 + 12 + 16);
    expect(await decryptBytes(k.files, enc, aad)).toEqual(data);
    // A changed byte, or the chunk put in another place: refused.
    const bent = enc.slice();
    bent[100]! ^= 1;
    expect(await decryptBytes(k.files, bent, aad)).toBeUndefined();
    expect(
      await decryptBytes(k.files, enc, new TextEncoder().encode('model.moc3#1')),
    ).toBeUndefined();
  });
});

const table: ParamInfo[] = [
  { id: 'ParamAngleX', min: -30, max: 30 },
  { id: 'ParamMouthOpenY', min: 0, max: 1 },
  { id: 'ParamFrame', min: 0, max: 10 },
];

describe('parameters over the data channel', () => {
  it('packs 16-bit values, within half a step of the range', () => {
    for (const v of [-30, -12.345, 0, 29.99, 30])
      expect(Math.abs(dequantize(quantize(v, -30, 30), -30, 30) - v)).toBeLessThan(60 / 65535);
    expect(quantize(99, 0, 1)).toBe(65535);
    expect(quantize(-1, 0, 1)).toBe(0);
    const b = encodeParams(123456, [
      [0, 1],
      [2, 65535],
    ]);
    expect(b.length).toBe(7 + 8);
    expect(decodeParams(b)).toEqual({
      time: 123456,
      entries: [
        [0, 1],
        [2, 65535],
      ],
    });
    expect(decodeParams(b.subarray(0, 9))).toBeUndefined();
  });

  it('sends only what changed, and everything to a newcomer', () => {
    const s = new ParamSender(table);
    expect(s.frame({ ParamAngleX: 10, ParamMouthOpenY: 0.5, Unknown: 3 })).toHaveLength(2);
    expect(s.frame({ ParamAngleX: 10, ParamMouthOpenY: 0.5 })).toEqual([]);
    expect(s.frame({ ParamAngleX: 11, ParamMouthOpenY: 0.5 })).toEqual([
      [0, quantize(11, -30, 30)],
    ]);
    expect(
      s
        .frame({ ParamAngleX: 11 }, true)
        .map(([i]) => i)
        .sort(),
    ).toEqual([0, 1]);
  });

  it('smooths between frames, a delay late, except parameters never smoothed', () => {
    const r = new RemoteParams(table, ['ParamFrame']);
    expect(r.sample(0, 50)).toEqual({});
    const at = (i: number) => i * 100;
    // Frames every 100 ms of the sender's clock, arriving with jitter.
    const jitter = [0, 30, 5, 60];
    [0, 10, 20, 30].forEach((x, i) =>
      r.push(at(i), 5000 + at(i) + jitter[i]!, [
        [0, quantize(x, -30, 30)],
        [2, quantize(i * 2, 0, 10)],
      ]),
    );
    // The fastest delivery sets the clock: frame i shows at 5000 + 100 i.
    const s = r.sample(5150 + 50, 50);
    expect(s.ParamAngleX).toBeCloseTo(15, 1);
    // Never smoothed: the frame before, not between.
    expect(s.ParamFrame).toBeCloseTo(2, 2);
    // Past the last frame: the last values.
    expect(r.sample(9000, 50).ParamAngleX).toBeCloseTo(30, 2);
    expect(r.latest()).toMatchObject({ ParamAngleX: expect.closeTo(30, 2) });
    // A parameter never received stays out.
    expect('ParamMouthOpenY' in s).toBe(false);
  });

  it('keeps time across the sender clock’s wrap', () => {
    const r = new RemoteParams(table);
    r.push(2 ** 32 - 50, 1000, [[0, quantize(0, -30, 30)]]);
    r.push(50, 1100, [[0, quantize(30, -30, 30)]]);
    expect(r.sample(1050, 0).ParamAngleX).toBeCloseTo(15, 1);
  });
});

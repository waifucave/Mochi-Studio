import { describe, expect, it } from 'vitest';
import { addressLimitSettings, AddressLimits, LIMITS, LimitsByAddress, RateWindow } from './limits';

describe('the signaling server’s limits', () => {
  it('counts messages a second on a connection', () => {
    const r = new RateWindow(3);
    expect([0, 10, 20, 30].map((t) => r.allow(t))).toEqual([true, true, true, false]);
    expect(r.allow(1000)).toBe(true);
  });

  it('caps one address’s connections, rooms and new connections a minute', () => {
    const a = new AddressLimits({
      connectionsPerAddress: 3,
      roomsPerAddress: 2,
      newConnectionsPerMinute: 4,
    });
    expect(a.admit('c1', 'r1', 0)).toBeUndefined();
    expect(a.admit('c2', 'r2', 0)).toBeUndefined();
    expect(a.admit('c3', 'r3', 0)).toBe('too-many-rooms');
    expect(a.admit('c3', 'r1', 0)).toBeUndefined();
    expect(a.admit('c4', 'r1', 0)).toBe('too-many-connections');
    a.release('c1');
    expect(a.admit('c5', 'r1', 0)).toBeUndefined(); // the fourth new connection this minute
    a.release('c5');
    expect(a.admit('c6', 'r1', 1000)).toBe('too-fast');
    expect(a.admit('c6', 'r1', 61_000)).toBeUndefined();
    // Through a snapshot, as the Worker keeps it.
    const b = AddressLimits.restore(JSON.parse(JSON.stringify(a.snapshot())), {
      connectionsPerAddress: 3,
      roomsPerAddress: 2,
      newConnectionsPerMinute: 4,
    });
    expect(b.admit('c7', 'r1', 61_000)).toBe('too-many-connections');
  });

  it('forgets an address with nothing open, and reads settings from strings', () => {
    const l = new LimitsByAddress({
      connectionsPerAddress: 1,
      roomsPerAddress: 1,
      newConnectionsPerMinute: 9,
    });
    expect(l.admit('1.2.3.4', 'c1', 'r', 0)).toBeUndefined();
    expect(l.admit('1.2.3.4', 'c2', 'r', 0)).toBe('too-many-connections');
    expect(l.admit('5.6.7.8', 'c3', 'r', 0)).toBeUndefined();
    l.release('1.2.3.4', 'c1', 0);
    expect(l.admit('1.2.3.4', 'c4', 'r', 0)).toBeUndefined();
    expect(addressLimitSettings({ roomsPerAddress: '3', connectionsPerAddress: 'x' })).toEqual({
      connectionsPerAddress: LIMITS.connectionsPerAddress,
      roomsPerAddress: 3,
      newConnectionsPerMinute: LIMITS.newConnectionsPerMinute,
    });
  });
});

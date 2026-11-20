import { X509Certificate } from 'node:crypto';
import { createServer } from 'node:https';
import type { AddressInfo } from 'node:net';
import { connect } from 'node:tls';
import { describe, expect, it } from 'vitest';
import { fingerprint, selfSignedCertificate } from '../../bridge/src/cert.ts';

describe('the phone tracker’s certificate', () => {
  it('names the addresses, signs itself, and is valid for a year', () => {
    const id = selfSignedCertificate(['192.168.1.20', '10.0.0.5', 'fe80::1']);
    const x = new X509Certificate(id.cert);
    expect(x.subjectAltName).toBe(
      'DNS:localhost, IP Address:192.168.1.20, IP Address:10.0.0.5, IP Address:FE80:0:0:0:0:0:0:1',
    );
    expect(x.subject).toContain('CN=Mochi Studio phone tracker');
    expect(x.issuer).toBe(x.subject);
    expect(x.verify(x.publicKey)).toBe(true);
    expect(x.ca).toBe(false);
    expect(x.keyUsage).toEqual(['1.3.6.1.5.5.7.3.1']);
    const days = (Date.parse(x.validTo) - Date.parse(x.validFrom)) / 86_400_000;
    expect(days).toBeGreaterThan(364);
    expect(days).toBeLessThan(366);
    expect(id.names).toEqual(['localhost', '192.168.1.20', '10.0.0.5', 'fe80::1']);
    expect(fingerprint(id.cert)).toMatch(/^([0-9A-F]{2}:){31}[0-9A-F]{2}$/);
  });

  it('serves TLS that a client trusting it accepts, for the addresses it names', async () => {
    const id = selfSignedCertificate(['127.0.0.1']);
    const server = createServer({ key: id.key, cert: id.cert }, (_req, res) => res.end('ok'));
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    const port = (server.address() as AddressInfo).port;
    const handshake = (host: string, servername?: string) =>
      new Promise<string>((resolve) => {
        const s = connect({ host, port, ca: id.cert, ...(servername ? { servername } : {}) });
        s.once('secureConnect', () => {
          resolve('trusted');
          s.end();
        });
        s.once('error', (e) => resolve((e as NodeJS.ErrnoException).code ?? e.message));
      });
    try {
      expect(await handshake('127.0.0.1')).toBe('trusted');
      expect(await handshake('127.0.0.1', 'localhost')).toBe('trusted');
      // A name it does not carry fails the identity check.
      expect(await handshake('127.0.0.1', 'example.org')).toBe('ERR_TLS_CERT_ALTNAME_INVALID');
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });
});

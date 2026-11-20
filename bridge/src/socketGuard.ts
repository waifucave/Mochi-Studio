/**
 * Errors on a connection never stop the bridge. Without a
 * listener, a socket's or a WebSocket's `error` event throws: one bad frame
 * from a plugin (or a reset during an upgrade) would end the whole process,
 * and with it every output view.
 */
import type { Duplex } from 'node:stream';
import type { WebSocket } from 'ws';

/** An upgrading socket: an error closes this connection only. */
export function guardSocket(socket: Duplex): void {
  socket.on('error', () => socket.destroy());
}

/** A WebSocket: `ws` closes it after a protocol error; this logs it and keeps the bridge running. */
export function guardWebSocket(ws: WebSocket, log: (m: string) => void, what: string): WebSocket {
  ws.on('error', (e) => log(`${what}: connection error (${e.message}); it was closed.`));
  return ws;
}

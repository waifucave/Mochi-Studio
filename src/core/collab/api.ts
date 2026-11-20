/**
 * Collaboration for agents: the session's state as
 * data, and what the Collab tab's buttons do. The app's collaboration
 * (src/web/collab/collabStage.ts) implements it.
 *
 * The invitation link is private: it is never in the state, only in what
 * `host` returns to the agent that asked.
 */

export interface CollabPersonState {
  id: string;
  name: string;
  host: boolean;
  me: boolean;
  connection: 'connecting' | 'connected' | 'failed' | 'closed';
  /** How their model comes: its files, video, or nothing yet. */
  model: 'shared' | 'video' | 'none';
  hidden: boolean;
  blocked: boolean;
  /** Placed on this screen by hand, instead of where they stand; and pinned to this app's model. */
  placedHere: boolean;
  pinnedHere: boolean;
  error?: string;
}

export interface CollabState {
  status: 'off' | 'connecting' | 'hosting' | 'waiting' | 'member' | 'ended';
  /** Why it ended, or the last thing to tell people. */
  message?: string;
  isHost: boolean;
  locked: boolean;
  /** The connection to the server dropped and the app is coming back. */
  reconnecting: boolean;
  people: CollabPersonState[];
  /** People asking to join (for the host). `valid`: their name decrypted, so they have the link. */
  knocks: { id: string; name: string; valid: boolean }[];
  /** Knocks declined for a wrong or missing password (host). */
  wrongPasswords: number;
  /** Everyone's ids back to front, as this screen draws them. */
  order: string[];
  /** This screen uses its own order instead of the shared one. */
  localOrder: boolean;
  /** The chat's last 50 messages (this session only). */
  chat: { name: string; text: string; at: number; me: boolean }[];
}

export interface CollabApi {
  state(): CollabState;
  /**
   * Opens a session with the app's settings (and a room password, if given);
   * resolves once the server has the room, with the link and the code to read aloud.
   */
  host(o?: { password?: string }): Promise<{ invitation: string; code: string }>;
  /** Asks to join from an invitation link or code; false when it is neither. */
  join(link: string, password?: string): boolean;
  /** The host's new invitation: the old link and code stop working. */
  newLink(): { invitation: string; code: string } | undefined;
  /** Sends a chat message; false when it is empty, too long, or too many at once. */
  chat(text: string): boolean;
  leave(): void;
  admit(peer: string): void;
  decline(peer: string): void;
  remove(peer: string): void;
  lock(locked: boolean): void;
  hide(peer: string, hidden: boolean): void;
  /** Places someone's avatar here by hand (and pins it to this app's model), or not. */
  placeHere(peer: string, on: boolean, pinned?: boolean): void;
  /** This screen's own order, back to front, or the shared one (undefined). */
  setLocalOrder(order: string[] | undefined): void;
  block(peer: string, blocked: boolean): void;
}

export const COLLAB_OFF: CollabState = {
  status: 'off',
  isHost: false,
  locked: false,
  reconnecting: false,
  people: [],
  knocks: [],
  wrongPasswords: 0,
  order: [],
  localOrder: false,
  chat: [],
};

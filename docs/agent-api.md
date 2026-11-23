# Mochi Studio agent API

AI agents and other programs can drive Mochi Studio's live avatar the way a
person uses the app: load a model, set expressions, play motions, show items,
move the model, speak with lip sync, and look at the result through
screenshots.

- [How it fits together](#how-it-fits-together)
- [Safety](#safety)
- [Setup](#setup): [the bridge](#1-start-the-bridge), [pairing](#2-turn-on-agent-access-and-pair), [tokens](#3-create-a-token), [MCP clients](#4-connect-an-mcp-client), [other programs](#other-programs-websocket)
- [Commands](#commands)
- [Events](#events)
- [The bridge protocol](#the-bridge-protocol) (for programs and other apps)

## How it fits together

```
 MCP client ──stdio── mochi-studio-bridge mcp ─┐
 program ─────WebSocket /api ─────────────────┤ bridge (127.0.0.1) ── WebSocket /host ── Mochi Studio page
                                               └─────────────────────────────────────────  (runs every command)
```

- **The page is the app.** Every command runs in the Mochi Studio page,
  through the same command layer the page's own buttons use. So agents can
  do what people can do, with the same checks, and their changes can be
  undone the same way.
- **The bridge relays.** A web page cannot accept connections, so a small
  Node program, `mochi-studio-bridge`, does it. The page connects to the
  bridge as its _host_; programs connect as _clients_. The bridge holds no
  app state: it checks tokens and scopes and passes messages along.
- **MCP.** `mochi-studio-bridge mcp` is an MCP server over stdio. It joins
  the running bridge as a client (or starts the bridge when none runs) and
  offers every command as a tool. `screenshot` returns an image, so the
  agent sees what it does.

## Safety

- **Off by default.** Nothing can control the avatar until the person turns
  on **Agent access** in the settings' General tab and pairs the page with the bridge,
  using a code the bridge prints.
- **This computer only.** The bridge listens on `127.0.0.1` only. It refuses
  connections whose `Host` header is not `localhost`, `127.0.0.1` or `[::1]`
  (so other websites cannot reach it through DNS rebinding). The host
  endpoint accepts only pages from `http(s)://localhost` and `127.0.0.1` (and
  origins given with `--allow-origin`). Clients that are web pages must come
  from those origins too.
- **A token per connection.** Each program or agent has its own token, made
  in the settings' General tab or with `mochi-studio-bridge token create`. The bridge
  stores only a SHA-256 hash of it. Tokens can be revoked; that disconnects
  their clients.
- **Scopes.** A token has some of three scopes:
  - `read`: read the state, the model's description, the log, and receive
    events;
  - `control`: change things (every command that is not reading or a
    screenshot);
  - `screenshot`: take screenshots.

  The bridge checks the scope of every command, and the page checks it
  again before running it.

- **Visible.** While an agent is connected, the page's status (top right) shows
  "● Agent: <name>", and the settings' General tab lists the agents and their recent
  commands.
- **No camera or microphone data.** No command or event carries video,
  audio, landmarks, blendshapes or tracked values. Tracking appears only as
  status (`tracking_found`, `tracking_lost`). `get_parameters` gives ranges,
  defaults and the values agents set, never the values tracking drives.
  Screenshots show the rendered avatar only. Agents cannot turn the camera or
  microphone on.
- **Limits.** Messages up to 16 MB; at most 30 commands per second per
  client; commands time out after 30 s (`speak` and `replay_log` after
  10 minutes).

## Setup

Requires Node 22.18 or later (the bridge is TypeScript that Node runs
directly). In a clone of Mochi Studio, `npm ci` once.

### 1. Start the bridge

```sh
npm run bridge                 # or: node bridge/bin.mjs
```

It prints its address (`ws://127.0.0.1:47830`) and a six-digit **pairing
code**. Options: `--port N`; `--allow-origin https://example.org` for a
Mochi Studio hosted elsewhere than localhost (repeatable).
`mochi-studio-bridge status` shows whether it runs, whether Mochi Studio is
connected, and the current pairing code.

### 2. Turn on agent access and pair

In Mochi Studio, open the **Agents** tab, tick **Agent access** (change the
bridge address if you used another port), and enter the pairing code. The
page remembers the pairing, so later it reconnects by itself while agent
access is on. A code is valid for 10 minutes and once; five wrong tries make
a new one.

### 3. Create a token

In the settings' General tab, under **Tokens**, give a name (for example "Claude") and
choose the scopes. The token is shown once, with setup snippets. Or on the
command line:

```sh
node bridge/bin.mjs token create --name Claude --scopes read,control,screenshot
node bridge/bin.mjs token list
node bridge/bin.mjs token revoke <id>
```

### 4. Connect an MCP client

Replace `/path/to/mochi-studio` and the token.

**Claude Code:**

```sh
claude mcp add mochi-studio -e MOCHI_STUDIO_TOKEN=mst_… -- node /path/to/mochi-studio/bridge/bin.mjs mcp
```

**Claude Desktop** (`claude_desktop_config.json`), **Cursor**
(`.cursor/mcp.json`) and other clients with an `mcpServers` setting:

```json
{
  "mcpServers": {
    "mochi-studio": {
      "command": "node",
      "args": ["/path/to/mochi-studio/bridge/bin.mjs", "mcp"],
      "env": { "MOCHI_STUDIO_TOKEN": "mst_…" }
    }
  }
}
```

**VS Code** (`.vscode/mcp.json`):

```json
{
  "servers": {
    "mochi-studio": {
      "type": "stdio",
      "command": "node",
      "args": ["/path/to/mochi-studio/bridge/bin.mjs", "mcp"],
      "env": { "MOCHI_STUDIO_TOKEN": "mst_…" }
    }
  }
}
```

Add `"--port", "N"` to `args` for another port.

**Start the bridge first** (`npm run bridge`), so you see its pairing code.
If no bridge runs, the MCP server starts one in its own process; its pairing
code then goes to the MCP client's log, and `npm run bridge -- status` (or
`mochi-studio-bridge status`) shows it.

The tools are the commands below, limited to the token's scopes. Results
are JSON, in `structuredContent` and in a text item. `screenshot` returns an
`image` item (`image/png`). A failed command returns `isError: true` and a
message that says what to do, for example
`Unknown expression "Frown". describe_model lists them: Smile, Blush.`
Annotations: `readOnlyHint` for reading tools and screenshots,
`destructiveHint: false` and `openWorldHint: false` for all.

### Other programs (WebSocket)

Connect to `ws://127.0.0.1:47830/api`, send `hello` with the token, then
commands. See [the bridge protocol](#the-bridge-protocol). For Node, the
repository has a small client (`bridge/src/client.ts`):

```ts
import { BridgeClient } from './bridge/src/client.ts';
const c = await BridgeClient.connect('ws://127.0.0.1:47830/api', process.env.MOCHI_STUDIO_TOKEN!);
c.subscribe(['hotkey_fired', 'tracking_*']);
c.onEvent((name, data) => console.log(name, data));
await c.command('set_expression', { expression: 'Smile' });
```

## Commands

Names, argument style and errors follow Mochi2D's own agent tools where they
overlap (`describe_model`, `set_parameters`, `play_motion`, snake_case,
messages that say what to do).

<!-- commands:start -->

| Command               | Scope      | Arguments                                                                                                                                         | What it does                                                                                                                                                                  |
| --------------------- | ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `get_state`           | read       |                                                                                                                                                   | The current state: model, camera and microphone status, expressions, items, stage and history.                                                                                |
| `describe_model`      | read       |                                                                                                                                                   | The loaded model: parameters (ids, names, ranges, defaults), expressions, motions, items, hotkeys and tracking inputs.                                                        |
| `get_parameters`      | read       | `ids?`                                                                                                                                            | Parameter ranges and defaults, and the values agents have set (overrides). Tracked values are not readable.                                                                   |
| `get_mapping`         | read       |                                                                                                                                                   | The tracking mapping rules (tracking input → model parameter).                                                                                                                |
| `list_hotkeys`        | read       |                                                                                                                                                   | The model’s hotkeys and what they do.                                                                                                                                         |
| `list_items`          | read       |                                                                                                                                                   | The items (props) of the loaded model, with visibility, placement and pin.                                                                                                    |
| `get_log`             | read       | `limit?`                                                                                                                                          | The latest commands run (by the UI, agents and replays), oldest first.                                                                                                        |
| `list_commands`       | read       |                                                                                                                                                   | Every command with its scope and argument schema.                                                                                                                             |
| `load_model`          | control    | `url`                                                                                                                                             | Loads a model from a URL of a .model3.json file or a .zip (the page fetches it).                                                                                              |
| `unload_model`        | control    |                                                                                                                                                   | Removes the model from the stage.                                                                                                                                             |
| `set_parameters`      | control    | `values`, `ttl_seconds?`                                                                                                                          | Sets parameter values that win over tracking, until cleared or until ttl_seconds pass. Undoable.                                                                              |
| `clear_parameters`    | control    | `ids?`                                                                                                                                            | Removes parameter values set with set_parameters (all, or the ids given), so tracking drives them again. Undoable.                                                            |
| `set_expression`      | control    | `expression`, `on?`                                                                                                                               | Turns an expression on or off (by name, or by .exp3.json path). Undoable.                                                                                                     |
| `clear_expressions`   | control    |                                                                                                                                                   | Turns every expression off. Undoable.                                                                                                                                         |
| `play_motion`         | control    | `group?`, `index?`, `name?`, `mode?`                                                                                                              | Plays a motion once, or holds its last frame (hold again to release). Name it by group and index, or by name or file.                                                         |
| `stop_motions`        | control    |                                                                                                                                                   | Stops the playing motion and releases a held one.                                                                                                                             |
| `list_item_scenes`    | read       |                                                                                                                                                   | The item scenes of the loaded model: id, name, group, their items, and whether each is on.                                                                                    |
| `set_item_scene`      | control    | `scene`, `on?`, `fade?`                                                                                                                           | Turns an item scene on (its items show where the scene has them; the other scenes of its group turn off) or off.                                                              |
| `create_item_scene`   | control    | `name`, `group?`, `items?`                                                                                                                        | Makes an item scene from items as they are placed now: by default every item shown now. Undoable.                                                                             |
| `remove_item_scene`   | control    | `scene`                                                                                                                                           | Removes an item scene (by id or name); its items stay as they are. Undoable.                                                                                                  |
| `set_item`            | control    | `id`, `visible?`, `x?`, `y?`, `scale?`, `rotation?`, `front?`, `pinned?`                                                                          | Shows or hides an item, places it (main-model units, degrees), puts it in front or behind, or pins it. Undoable.                                                              |
| `fire_hotkey`         | control    | `id`                                                                                                                                              | Fires a hotkey as if its keys were pressed. For "while held" hotkeys, call release_hotkey to let go.                                                                          |
| `release_hotkey`      | control    | `id`                                                                                                                                              | Releases a "while held" hotkey fired with fire_hotkey.                                                                                                                        |
| `set_mapping`         | control    | `rules`, `mirror?`                                                                                                                                | Replaces the tracking mapping rules (tracking input → model parameter, with ranges, invert, clamp and smoothing). Undoable.                                                   |
| `update_mapping_rule` | control    | `id`, `input?`, `output?`, `enabled?`, `inMin?`, `inMax?`, `outMin?`, `outMax?`, `invert?`, `clamp?`, `smoothing?`, `followPhysics?`, `smoother?` | Changes some fields of one mapping rule (by id; get_mapping lists them). Undoable.                                                                                            |
| `calibrate`           | control    |                                                                                                                                                   | Calibrates the neutral pose: the person looks straight ahead for about 4.5 s. Needs the camera on (or a phone tracking). Undoable.                                            |
| `set_lip_sync`        | control    | `type?`, `motionSync?`, `voiceProcessing?`, `vowelForm?`, `frequencyWeights?`, `mode?`, `weight?`, `gain?`, `gate?`                               | How the microphone’s lip sync combines with the tracked mouth, its sensitivity and its noise gate. Undoable.                                                                  |
| `set_background`      | control    | `kind`, `color?`, `image?`, `fit?`, `per_model?`                                                                                                  | Sets the background: transparent, chroma (key color), color, or image (a data: URL). Undoable.                                                                                |
| `set_transform`       | control    | `x?`, `y?`, `zoom?`, `rotation?`                                                                                                                  | Places the model: x, y (canvas heights from the centre, y down), zoom (1 = fitted) and rotation (degrees, clockwise). Undoable.                                               |
| `set_frame_cap`       | control    | `fps`                                                                                                                                             | Caps the frame rate (0 = uncapped). Undoable.                                                                                                                                 |
| `set_spout`           | control    | `outputs`                                                                                                                                         | Spout2 output in the desktop app on Windows: up to four outputs, each sent as MochiStudio, MochiStudio2, … Undoable.                                                          |
| `set_virtual_camera`  | control    | `enabled?`, `width?`, `height?`, `fps?`, `mirror?`, `background?`                                                                                 | The virtual camera in the desktop app (Linux; Windows once installed from the Camera tab): the avatar as a camera named "Mochi Studio Camera" that other apps open. Undoable. |
| `collab_host`         | control    | `password?`                                                                                                                                       | Opens a collaboration session with the app’s Collab settings, and returns the invitation link and its code.                                                                   |
| `collab_join`         | control    | `link`, `password?`                                                                                                                               | Asks to join a collaboration session from its invitation link or code.                                                                                                        |
| `collab_new_link`     | control    |                                                                                                                                                   | The host makes a new invitation: the old link and code stop working; people already in stay.                                                                                  |
| `collab_chat`         | control    | `text`                                                                                                                                            | Sends a chat message to everyone in the session (text only, at most 500 characters).                                                                                          |
| `collab_leave`        | control    |                                                                                                                                                   | Leaves the session (the host ends it for everyone).                                                                                                                           |
| `collab_answer`       | control    | `peer`, `admit`                                                                                                                                   | The host lets someone in who asked to join, or declines.                                                                                                                      |
| `collab_remove`       | control    | `peer`                                                                                                                                            | The host removes a participant; their app can’t ask again in this session.                                                                                                    |
| `collab_lock`         | control    | `locked`                                                                                                                                          | The host locks the session (no one else can ask to join), or opens it again.                                                                                                  |
| `collab_hide`         | control    | `peer`, `hidden`                                                                                                                                  | Hides a participant’s avatar on this screen (and its output views) only, or shows it again.                                                                                   |
| `collab_place`        | control    | `peer`, `here`, `pinned?`                                                                                                                         | Places a participant’s avatar on this screen by hand: it stays where it is (or where it is dragged) instead of where they stand, and with pinned, follows this app’s model.   |
| `collab_order`        | control    | `order?`                                                                                                                                          | Sets this screen’s own front-to-back order of everyone (ids or nicknames, back first), or with none, the shared order again.                                                  |
| `collab_block`        | control    | `peer`, `blocked`                                                                                                                                 | Blocks a participant on this screen: hidden, and what they send (expressions, motions) is ignored. They aren’t told.                                                          |
| `speak`               | control    | `audio`, `volume?`                                                                                                                                | Plays a sound (WAV, MP3, Ogg…, base64) and moves the mouth with it. Resolves when it ends.                                                                                    |
| `screenshot`          | screenshot |                                                                                                                                                   | A PNG of the avatar as it is now, with a transparent background.                                                                                                              |
| `undo`                | control    |                                                                                                                                                   | Undoes the latest change of settings, expressions or parameter values.                                                                                                        |
| `redo`                | control    |                                                                                                                                                   | Runs the latest undone command again.                                                                                                                                         |
| `replay_log`          | control    | `entries`, `keep_timing?`                                                                                                                         | Runs logged commands again, in order (control commands only), as get_log returns them.                                                                                        |

<!-- commands:end -->

Notes:

- **Start with** `get_state` and `describe_model`. `describe_model` lists
  parameter ids with ranges and defaults, expressions, motions (with group,
  index and name), items, hotkeys, and the tracking input ids mapping rules
  can use.
- **Parameters.** `set_parameters` values win over tracking until
  `clear_parameters`, or until `ttl_seconds` pass. Motions, expressions,
  physics, blinking and breathing still apply on top, as in Mochi2D.
- **Parameters physics overwrites.** On some models physics writes a
  parameter every frame from another one (DeepSeek-chan's `ParamAngleX`
  follows its own `AngleX`). `describe_model` and `get_parameters` mark
  such parameters with `drivenByPhysicsFrom` (the name Mochi2D's tools use).
  Setting them has no visible effect; `set_parameters` says so in
  `drivenByPhysics` and `note`, with the parameter to set instead. Tracking
  makes this switch by itself.
- **Placement.** `set_transform` uses canvas heights from the centre (x to
  the right, y down), zoom 1 = fitted, rotation in degrees clockwise.
  `set_item` uses the main model's units (y up) and degrees
  counterclockwise, as Mochi2D's items do.
- **Undo.** Commands marked "Undoable" can be undone with `undo` (by the
  UI's undo button and Ctrl+Z too; the history is shared). `redo` runs the
  undone command again.
- **Log and replay.** `get_log` returns the latest commands from the UI,
  agents and replays (reads and screenshots are not logged; long strings
  such as audio are left out). `replay_log` runs such entries again, in
  order: control commands only, optionally with their original timing.
- **Speech.** `speak` plays audio (base64; WAV, MP3, Ogg… up to 10 MB) and
  moves the mouth with it, in the page and in output views. Text-to-speech
  is up to the agent.
- **Models.** `load_model` takes an http(s) URL that the page fetches.
  Agents cannot open local folders: the browser reads only files the person
  picks.

Not commands, on purpose: turning the camera or microphone on or off,
adding or removing items (they need files the person picks), loading files
from disk, editing hotkeys, the tracking filter, and the settings import.
These stay with the person at the computer.

## Events

Subscribe with `{ "type": "subscribe", "events": ["*"] }`, a name, or a
prefix such as `"tracking_*"`. Events need the `read` scope.

| Event                                   | Data                                                                                 |
| --------------------------------------- | ------------------------------------------------------------------------------------ |
| `model_loaded`                          | `name` (settings file), `key`                                                        |
| `model_unloaded`                        |                                                                                      |
| `settings_changed`                      | (bursts become one event)                                                            |
| `expression_changed`                    | `expressions`: the ones on                                                           |
| `motion_finished`                       | `group`, `index`                                                                     |
| `hotkey_fired`                          | `id`, `label`                                                                        |
| `hotkey_released`                       | `id` (for "while held" hotkeys)                                                      |
| `item_changed`                          | `items`: `id`, `name`, `visible`                                                     |
| `tracking_started`, `tracking_stopped`  | the camera went on or off                                                            |
| `tracking_found`, `tracking_lost`       | a face is seen or no longer seen                                                     |
| `microphone_changed`                    | `on`                                                                                 |
| `command_executed`                      | a log entry: `seq`, `time`, `origin` (`kind`, `name`), `name`, `args`, `ok`, `error` |
| `history_changed`                       | `canUndo`, `canRedo`                                                                 |
| `agent_connected`, `agent_disconnected` | `name` (from the bridge)                                                             |

## The bridge protocol

Version 1. This section is complete on its own, so another app (a host other
than Mochi Studio, or a client in any language) can implement it. The types
are in `src/core/bridgeProtocol.ts`.

### Transport

- WebSocket on `127.0.0.1`, default port **47830**. Three paths: `/host`
  for the app that runs commands, `/api` for clients, `/view` for output
  views; and HTTP `GET /files/…` for views. `GET /` returns
  `{ app, version, protocol, studio: { connected }, host: { connected, app }, endpoints }`.
- **`host`** names the app connected as host (the `app` of its `host_hello`,
  `mochi-studio` for Mochi Studio, or `null` with none), so clients of other
  hosts on this protocol can tell them apart. `studio` stays for version-1
  clients and means the same as `host.connected`.
- Each message is one JSON object in a text frame, with a string `type`.
  Messages up to 16 MiB.
- Connections are refused (HTTP 403) when the peer is not a loopback
  address, the `Host` header is not `localhost`, `127.0.0.1` or `[::1]`
  (any port), or the `Origin` is not allowed: `/host` requires an origin of
  `http(s)://localhost` or `127.0.0.1` (any port) or one configured with
  `--allow-origin`; `/view` likewise; `/api` allows no origin (programs) or
  an allowed one.
- **Three kinds of access, kept apart.** A _host token_ (`msh_…`, from
  pairing) lets one app be the host. A _client token_ (`mst_…`) lets a
  program run commands within its scopes. A _view key_ (`msv_…`) lets an
  output view display the avatar: it gets the final parameter values every
  frame (which come from tracking) and the model's files, and nothing else:
  no commands, no events, no tokens. Each is refused where the others are
  accepted.

### Host: handshake and pairing

1. The host sends
   `{ "type": "host_hello", "protocol": 1, "app": "mochi-studio", "version": "0.1.0", "hostToken": "msh_…" }`
   (`hostToken` once it has one).
2. With a valid host token, the bridge answers
   `{ "type": "host_welcome", "protocol": 1, "bridge": { "version", "port" } }`.
   Otherwise `{ "type": "pair_required", "message" }`.
3. To pair, the host sends `{ "type": "pair", "code": "123456" }`: the code
   the bridge shows its user. On success the bridge sends
   `{ "type": "paired", "hostToken": "msh_…" }` (keep it) and then
   `host_welcome`. On failure, `{ "type": "pair_failed", "message" }`.
   Codes are six digits, valid 10 minutes and once; five wrong tries make a
   new one.
4. After `host_welcome`, the host sends its catalog:
   `{ "type": "catalog", "commands": [CommandInfo…], "events": ["…"] }`,
   where `CommandInfo` is
   `{ name, summary, details?, scope, undoable, readOnly, inputSchema }`
   and `inputSchema` is a JSON Schema of the arguments.

One host at a time: a newer host that completes the handshake replaces the
older one, which is closed with code 4000. The older app should tell its
user that another window took over, and not reconnect by itself.

After `host_welcome` the host also says whether agents may connect:
`{ "type": "host_options", "agents": true|false }`. With `false`, the
bridge closes connected clients (4403) and refuses new ones with
`agents_off`; output views keep working.

### Host: running commands

- The bridge sends
  `{ "type": "command", "id", "client": { "id", "name", "scopes" }, "name", "args" }`.
  `id` is the bridge's; the host must check `scopes` itself as well.
- The host answers `{ "type": "result", "id", "ok": true, "result": … }` or
  `{ "type": "result", "id", "ok": false, "error": { "code", "message" } }`.
- The host sends events whenever they happen:
  `{ "type": "event", "name", "data" }`. The bridge forwards them to
  subscribed clients with the `read` scope.
- The bridge tells the host who is connected, on every change:
  `{ "type": "clients", "clients": [{ "id", "name", "scopes", "connectedAt" }] }`.
  Show it to the user.

### Host: tokens

The host can manage client tokens for its user:

| Host sends                                                               | Bridge answers                                                                      |
| ------------------------------------------------------------------------ | ----------------------------------------------------------------------------------- |
| `{ "type": "token_create", "requestId", "name", "scopes": ["read", …] }` | `{ "type": "token_created", "requestId", "token": "mst_…", "info": TokenInfo }`     |
| `{ "type": "token_list", "requestId" }`                                  | `{ "type": "tokens", "requestId", "tokens": [TokenInfo…] }`                         |
| `{ "type": "token_revoke", "requestId", "id" }`                          | `{ "type": "token_revoked", "requestId", "id" }` (its clients are closed with 4401) |

`TokenInfo` is `{ id, name, scopes, created, lastUsed }` (milliseconds since
the epoch, `lastUsed` may be null). The token itself appears only in
`token_created`.

### Output views

Output views show the avatar outside the host's browser profile (an OBS
browser source). The host and the bridge relay the host's own view messages
(Mochi Studio's `SyncMessage`s, `src/core/sync.ts`) as JSON, with byte
arrays as `{ "$bytes": "<base64>" }`.

**The view key.** The host asks for it with
`{ "type": "view_key", "requestId", "renew": false }`. The bridge answers
`{ "type": "view_key", "requestId", "key": "msv_…" }` with a new key when
`renew` is true or none exists, else `key: null` (the host keeps the key it
got; the bridge stores only a hash). One key at a time: a new key ends the
old one. Mochi Studio puts it in the view's address:
`output.html?bridge=ws://127.0.0.1:47830&view=msv_…`.

**The view's connection** (`/view`):

1. Within 5 s the view sends
   `{ "type": "view_hello", "protocol": 1, "key": "msv_…", "viewId": "…" }`.
   The bridge answers
   `{ "type": "view_welcome", "protocol": 1, "studio": { "connected" }, "host": { "connected", "app" } }`,
   or an `unauthorized` error and closes with 4401. A view that sends no
   `view_hello` in time is closed with 4408 and connects again.
2. The view sends `{ "type": "sync", "message": { "type": "hello", "viewId" } }`
   when it starts and again whenever `{ "type": "studio", "connected": true }`
   arrives, and `bye` when it closes. Views may send only `hello` and `bye`.
3. The bridge passes the host's `{ "type": "sync", "message" }` to every
   view. When a view's connection closes without `bye`, the bridge sends the
   host a `bye` for it. It also tells the host `{ "type": "views", "count" }`.

**Files.** Model and item files do not travel in messages. Over the bridge,
the host sends `modelRemote` (`key`, `label`, `paths`, `sizes`) and
`itemsRemote` (`items`: `id`, `label`, `visible`, `paths`, `sizes`) in
place of the messages that carry files.

- **The host uploads the files** to the bridge, one at a time, as soon as it
  has opened a model's files with bridge views on, before the model itself
  loads (Mochi Studio uploads from a Web Worker, so loading and rendering do
  not slow it down; `?uploadInPage` on the page's address uploads from the
  page instead, for comparison):
  `PUT /upload/(model|item)/<owner>/<path>` with
  `Authorization: Bearer <host token>` and the bytes as the body (204 when
  stored). `HEAD` on the same address answers 200 with the
  `Content-Length` when the bridge has the file already (after the page
  reloads), 404 otherwise. The bridge keeps the files in memory (at most
  2 GiB) while the host shows that model and those items, and across
  reconnects of the same host. A different host clears them.
- **Folders on disk (the desktop app).** A folder opened with the desktop
  app's native dialog is registered with the bridge by the app's main
  process; pages cannot name paths. The host reads its files with
  `GET /disk/<folder id>/<path>` and `Authorization: Bearer <host token>`,
  and instead of uploading sends
  `{ "type": "disk_source", "scope": "model", "owner": <model key>, "folderId", "prefix" }`
  (`prefix`: the manifest's folder inside it, or `""`). The bridge then
  answers views' requests for that model straight from disk, until the host
  shows another model. Nothing outside the folder is served, through `..` or
  through symbolic links.
- **The view reads each file** when it needs it (Mochi Studio's views fetch
  every file at once, six at a time):
  `GET /files/model/<model key>/<path>?key=<view key>` or
  `GET /files/item/<item id>/<path>?key=<view key>` (each path segment
  URL-encoded). Answers: 200 with the bytes, 401 (bad key), 404, 503 (no
  host), 504 (timed out). CORS headers allow the allowed origins.
- **A file the bridge does not have yet:** if it is being uploaded, the
  request waits for the upload. Otherwise the bridge asks the host:
  `{ "type": "file_request", "id", "scope": "model"|"item", "owner", "path" }`.
  The host either uploads that file next (the bridge answers the view from
  the upload), or sends it as binary frames: each a 4-byte big-endian header
  length, a UTF-8 JSON header `{ "id", "size"?, "done" }`, then up to 1 MiB
  of the file. The first chunk has `size` (the Content-Length); the last has
  `done: true`. If the host cannot serve it:
  `{ "type": "file_error", "id", "message" }`.
- **Progress.** Views may also send
  `{ "type": "sync", "message": { "type": "viewStatus", "viewId", "state": "loading"|"ready"|"failed", "loaded", "total", "ms", "message"? } }`;
  the bridge passes it to the host, which shows it (an OBS view must not
  show it itself).

### Clients

1. Within 5 seconds of connecting, the client sends
   `{ "type": "hello", "protocol": 1, "token": "mst_…", "client": { "name": "…" } }`.
2. The bridge answers
   `{ "type": "welcome", "protocol": 1, "name", "scopes", "studio": { "connected" }, "host": { "connected", "app" }, "commands": [CommandInfo…], "events": ["…"] }`,
   or `{ "type": "error", "error": { "code": "unauthorized", "message" } }`
   and closes with 4401.
3. Commands: `{ "type": "command", "id": "1", "name": "set_expression", "args": { … } }`.
   The answer has the same `id`:
   `{ "type": "result", "id": "1", "ok": true, "result": … }` or
   `{ "type": "result", "id": "1", "ok": false, "error": { "code", "message" } }`.
4. Events: `{ "type": "subscribe", "events": ["*"] }` (names, `*`, or
   prefixes ending in `*`; at most 100), answered by
   `{ "type": "subscribed", "events": […] }`; `unsubscribe` likewise. Then
   `{ "type": "event", "name", "data", "time" }`.
5. `{ "type": "studio", "connected": true|false }` arrives when the host
   connects or leaves, followed by `{ "type": "host", "connected", "app" }`
   (views get both too).

### Host: the plugin server

The bridge also runs the server for plugins made for VTube Studio
([plugins.md](plugins.md)), on its own port. The host switches it and
answers the requests that need the app's state:

- Host → bridge: `{ "type": "plugins_options", "on" }`;
  `{ "type": "plugin_approval", "requestId", "allow" }`;
  `{ "type": "plugin_result", "id", "data" }` or with `errorID` and
  `message`; `{ "type": "plugin_event", "name", "data" }` (the bridge
  applies each subscription's config); `{ "type": "plugin_revoke", "pluginId" }`;
  `{ "type": "plugin_grant", "pluginId", "trackingData" }`.
- Bridge → host: `{ "type": "plugins", "on", "port", "problem"?, "plugins": [PluginInfo…], "parameters": [CustomParameter…] }`
  on every change; `{ "type": "plugin_approval_request", "requestId", "name", "developer", "icon" }`
  and `plugin_approval_cancel`; `{ "type": "plugin_request", "id", "plugin": { "id", "name", "trackingData", "session" }, "messageType", "data" }`;
  `{ "type": "plugin_session_end", "pluginId", "session" }`.

The types are in `src/core/plugins/protocol.ts`.

### Errors

`error.code` is stable, `error.message` is for people and says what to do.

| Code                                                                                                                                                                               | Meaning                                                                     |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| `unauthorized`                                                                                                                                                                     | no hello, or an unknown token                                               |
| `forbidden`                                                                                                                                                                        | the token lacks the command's scope                                         |
| `invalid_message`                                                                                                                                                                  | not a JSON object with a known `type`, or a command without `id` or `name`  |
| `invalid_arguments`                                                                                                                                                                | the arguments do not fit the command's schema (the message names the field) |
| `unknown_command`                                                                                                                                                                  | no such command                                                             |
| `studio_not_connected`                                                                                                                                                             | no host is connected                                                        |
| `rate_limited`                                                                                                                                                                     | more than 30 commands in a second                                           |
| `timeout`                                                                                                                                                                          | no result in time                                                           |
| `no_model`, `unknown_expression`, `unknown_motion`, `unknown_item`, `unknown_hotkey`, `unknown_rule`, `camera_off`, `unavailable`, `no_session`, `not_host`, `unknown_participant` | the command's own errors                                                    |
| `failed`                                                                                                                                                                           | anything else                                                               |
| `protocol`                                                                                                                                                                         | the other side speaks another protocol version                              |
| `agents_off`                                                                                                                                                                       | agent access is off in the app                                              |

### Versioning

`protocol` is 1. A side that receives another version answers with a
`protocol` error. Additions (new message types, new fields, new commands and
events) keep the version; receivers ignore what they do not know.

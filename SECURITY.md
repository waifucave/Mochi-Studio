# Security

## Reporting a vulnerability

Please report vulnerabilities privately, through GitHub's **private
vulnerability reporting**: on the repository's **Security** tab, choose
**Report a vulnerability**. Do not open a public issue for it.

Say what you found, how to reproduce it, and what it lets someone do. You
will get an answer within a week. Once a fix is released, the advisory is
published, with credit to you if you want it.

## Supported versions

Mochi Studio is before its first stable release. Only the latest release,
and the `main` branch, get security fixes.

| Version        | Supported |
| -------------- | --------- |
| latest release | yes       |
| `main`         | yes       |
| anything older | no        |

## What Mochi Studio exposes

Knowing where the app talks to the network and reads files helps judge a
report. Everything below is off until the person switches it on, unless it
says otherwise.

**On the network:**

- **The bridge** (`mochi-studio-bridge`, built into the desktop app): an
  HTTP and WebSocket server on `127.0.0.1` only (port 47830 by default),
  for the agent API and its MCP server. Agents connect with a pairing code
  and get a token per connection, with scopes; pages from other origins
  than localhost are refused. Off until **Agent access** is switched on.
- **The plugin server:** the WebSocket API of plugins made for VTube
  Studio, on `localhost` only (port 8001 or the next free one), with a
  per-plugin token the person grants, and a discovery broadcast on UDP
  port 47779. Off until switched on.
- **The phone tracker:** an HTTPS and WebSocket server on the local network
  (port 27890 or the next free one), with a certificate made on this
  computer and a pairing per phone that can be revoked. It receives
  tracking values only; the phone's camera picture never leaves the phone.
  Off until switched on.
- **Collaboration:** a WebSocket connection to the signaling server the
  person sets (none by default), and WebRTC connections to the other
  participants, through a relay only by default ("Hide my address"). Model
  files, when a person chooses to share them, are encrypted with a key
  from the invitation's secret, which the server never sees. The included
  signaling server (`collab/`), under Node or as a Cloudflare Worker
  (`collab/worker/`), keeps a room's state only while the room is open,
  logs nothing beyond counts, and limits each address's connections and
  rooms (`src/core/collab/limits.ts`).
- **Fetching:** a model or item from a URL the person gives, and web items
  (web pages the person adds as items), which the desktop app renders off
  screen in a sandboxed window.

**Files:**

- **Model folders and zips** the person opens, read in the page as data:
  the model's files are parsed by Mochi2D, and nothing in them is run.
- **Settings files** made for VTube Studio, imported as data (never run).
- **The desktop app** keeps its settings and the bridge's tokens in the
  user's application data folder; its pages are sandboxed with context
  isolation, and open other sites in the system browser only.
- **Native modules:** the Spout2 sender (Windows) and the virtual camera
  module (Linux) take frames from the app's own output page only.

**Never:** the camera picture and the microphone's sound are processed
locally and are never recorded, stored or sent, to agents, plugins or
other participants neither.

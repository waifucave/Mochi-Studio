# Collaboration: design and hosting

Several people's avatars on one shared stage, each person's app showing
everyone. This page describes how it works, what it sends, and how to run
the signaling server it needs.

**No signaling server is set or run:** Mochi Studio sets none, and the
project runs none. To collaborate, one of you runs a server (see [Hosting a server](#hosting-a-server)) or uses one
a friend runs, and everyone puts its address in **Settings → Collab →
Signaling server**. An invitation link carries its server's address, so
people joining by link need nothing else.

## In short

- **Who:** up to **6 people**. One hosts, and the others join with an
  invitation. The host lets each one in.
- **What travels:** each participant's parameters and position, many
  times a second, straight between the apps over WebRTC.
- **The models,** in one of two ways, chosen per model:
  - **Video only** (the default): the others get a video of the model,
    never its files.
  - **Shared model:** the model's files go once to the others, encrypted,
    and are kept in memory only. They draw it themselves, so it looks and
    moves as it does at home.
- **The servers:** a small signaling server introduces the apps to each
  other; a relay (TURN) carries the traffic when they can't reach each
  other directly, and hides their addresses from each other.
- **Moderation:** nicknames only; the host lets in, declines, locks and
  removes; anyone can hide or block a participant on their own screen.

## Status

**Built:**

- **The signaling server,** under Node (`npm run collab:server`) and as
  a Cloudflare Worker ([Run it on Cloudflare](#run-it-on-cloudflare)), with
  the same rooms, routes and limits: rooms,
  the door (knock, let in, decline, lock, remove, with a removed app
  refused again), a 60-second grace for any member whose connection drops,
  expiry after 12 hours, counts only in its log, and short-lived TURN
  credentials when a TURN server is configured.
- **In the app** (the **Collab** tab):
  - host, the invitation link and code, a room password, a new link,
    join, the waiting room, leave, remove, lock;
  - hide, block, the smoothing delay, "Place them myself" and "My own
    order";
  - chat;
  - "Hide my address";
  - reconnecting to the server within the grace, as host or guest.
- **State over data channels:** parameters, expressions and motions,
  positions and the shared order, smoothed on arrival.
- **Shared models** and **video-only models** (below).
- **The others' avatars in output views** (OBS).
- **The agent API:** `get_state.collab` and twelve `collab_*` commands
  (see [agent-api.md](agent-api.md)).

**Not yet:**

- **Your items for everyone:** today each person's items stay on their
  own screen.
- **Pinning items across participants,** with consent. It needs the
  items above, a consent exchange, and, on third screens, a way to follow
  another avatar: Mochi2D pins items to the main model only, so there an
  item could only follow the whole avatar, not a part of it.

## 1. Hosting and joining

**Starting a session.** In **Settings → Collab**, the host sets:

- **their nickname;**
- **People:** 2 to 6;
- **Updates a second:** 10 to 60, 30 by default;
- **Password** (optional).

**The invitation.** **Start a session** gives an invitation link:

```
https://<signaling host>/join/<room>#<secret>.<door>
```

- **The room id** is random.
- **The secret,** after `#`, is 128 random bits. Browsers never send the
  part after `#` to a server, so the server never learns it. The apps
  derive the session's keys from it (section 3).
- **The door token** (48 random bits) names this invitation. **Make a new
  link** gives a new one; the server then refuses the old link, while the
  people already in stay.
- **The code:** the same invitation as a code to read aloud or type,
  `MOCHI-` and ten groups of five characters in Crockford's base32 (no I,
  L, O or U; case, spaces and dashes don't matter). It holds the room, the
  secret and the door token, so it is the whole invitation, not a weaker
  one: 50 characters are what 128 bits of secret take. It doesn't hold the
  server's address, so the person joining needs the same **Signaling
  server** setting.
- **On screen:** **Show invitation** and **Show code** show them for 30
  seconds, so they don't stay on stream.
- **The server's join page** (`/join/<room>`) only says to paste the link
  into Mochi Studio.

**Joining.** A guest pastes the link or types the code, adds the
password if the host set one, picks a nickname, and presses **Ask to
join**. The host sees the nickname with **Let in** and **Decline**.

- **A leaked link isn't enough:** the host still decides, at the moment.
- **No accounts:** none are needed, and Mochi Studio has none.
- **The password** is never sent. The guest's app sends an HMAC-SHA256
  proof of it, keyed with the password, inside the encrypted knock, so the
  server can neither read it nor try passwords against it. The host's app
  checks it: a wrong or missing one is declined at once, and the tab
  counts those.

**Closing the door.** **Lock** stops new requests; **Make a new link**
retires the old link and code.

**Leaving and ending.**

- **Leaving:** a guest can leave at any time. Their avatar goes for
  everyone, and their shared files are deleted from the others' memory.
- **The host leaving** ends the session for everyone.
- **A dropped connection** to the server, host's or guest's, gets 60
  seconds to come back. The others keep seeing that person meanwhile;
  only new people can't join until the host is back.
- **A session** ends after 12 hours, when the server's room expires.

## 2. What each participant sees and controls

**The shared stage.** A 16:9 stage of the same size for everyone, in
units, not pixels, so positions agree whatever each window's size. Each
person sees the whole stage in their own window, and their output views,
Spout2 and the virtual camera show it as usual. You move, scale and rotate
your own avatar as at home, and everyone sees it there.

**The order.**

- **One shared front-to-back order.** **Bring my avatar to the front**
  puts yours in front for everyone.
- **My own order (front first):** a switch that sets the order on your
  screen only, with ▲ and ▼ per person; anyone not in it keeps the shared
  order.

**Per participant**, in the list:

- **Hide:** their avatar, on your screen only.
- **Smoothing delay:** 0 to 1 s, 0.05 by default. It holds their movement
  back a little to hide network stutter.
- **Block:** hide them and ignore what they send (expressions, motions,
  chat), on your screen only. They aren't told.
- **Place them myself:** their avatar stays where you drag it on your
  screen, not where they stand. **Pin to my model** then makes it follow
  your own model, like a pinned item.

**What the list shows:** each nickname, the connection, and whether the
model is shared or video only, with progress while a shared model
arrives. Nothing else about anyone, so it is safe to show on stream.

**Chat:** text only, up to 500 characters a message and 5 messages in 10
seconds per sender, enforced by every app on what it sends and receives.
The last 200 messages are kept in memory on each computer, and are gone
when the session ends. Nothing is written to disk or to the log.

**Plugins and agents.** Plugins keep seeing only their own app's model.
Agents can run a session through the agent API.

## 3. What is sent

All of it goes over WebRTC: data channels for state, files and chat, and
a video track for video-only models. WebRTC encrypts everything between
the apps (DTLS and SRTP).

**State, many times a second.** Each participant sends to every other:

- **Parameter values:**
  - after tracking, mapping and expressions, before physics: each
    receiver runs the sender's physics itself, so hair moves smoothly
    whatever the network does;
  - 16 bits each, scaled to the parameter's range;
  - only the ones that changed;
  - at the host's rate;
  - on a reliable, ordered channel, so a lost update never leaves a stale
    value.
- **Expression and motion changes,** as events.
- **Position, scale, rotation and order,** when they change.

**Its cost:** a model with 100 parameters, half of them moving, at 30
updates a second, is about 3 KB/s, or 24 kbit/s per receiver: about
120 kbit/s up to 5 others.

**Smoothing.** Receivers interpolate between updates, a smoothing delay
late. Parameters the model's settings file lists as never smoothed
(`ParametersExcludedFromVNetSmoothing`) jump from value to value instead,
for frame-by-frame effects.

**Shared models: the files, once.**

- **Sent** when a participant joins or loads another model, in chunks,
  with progress in the list.
- **Encrypted twice:** by WebRTC in transit, and by a key derived from
  the invitation's secret (AES-GCM, each chunk bound to its file and
  place), so even a relay never holds usable bytes.
- **Kept** in memory only, never on disk, and deleted when the sender
  leaves or is removed, or the session ends.
- **Limits on a model:** 160 MB in all, 32 MB a file and 500 files; its
  textures PNG, JPEG, WebP, GIF, BMP or ICO files, at most 8192 pixels a
  side and 67,108,864 pixels together (8192 × 8192: one texture of that
  size, or four of 4096 × 4096), each file long enough for the size it
  claims. The largest models we
  know of are about half of each. A model over any of these always goes
  as video, and the sender's Collab tab says which limit. (The figures are
  set in `src/core/archiveLimits.ts`: `SHARED_MODEL_LIMITS`,
  `SHARED_TEXTURE_LIMITS` and `SHARED_HELD_BYTES`.)
- **Limits on an app:** one app holds at most 600 MB of the others' shared
  models at once. When a newer one doesn't fit, it waits: its sender's
  list says "Their app has no room for your model now", and the model goes
  to that app by itself once someone else's model is gone (they leave, or
  load another). Video-only models don't count: they always come.
- **Checked before anything is set aside:** each app checks a model's list
  of files against these limits before it sets any memory aside, and its
  textures' headers before anything decodes them (with Mochi2D's header
  reader, and the same caps the model is then loaded with). If one refuses
  it, it says why (**too large**, **damaged**, a picture format it doesn't
  open, or **no room**), and the sender's list shows the reason beside that
  person's name.
- **No sounds:** a shared model plays none of its own motion sounds on the
  others' screens (it moves by its owner's parameters). Their Collab tab
  says so beside the sender's name when the model has some.
- **No file server:** the sender pays the upload once per receiver, and no
  third party holds the files.
- **What memory-only can't stop:** a participant with the right tools
  could copy a shared model from their app's memory while the session
  runs. The app says so when you choose **its files (shared model)**. Share only with
  people you trust, and only models whose licence allows it.

**Video-only models.** The model's files never leave the sender's
computer:

- **The stream:** the sender's app draws the model alone, on a transparent
  background, and sends it as a video track.
- **Transparency:** WebRTC video carries no alpha, so the frame is sent
  double height, colour above and alpha below as grey, and the receivers
  recombine them in a WebGL pass.
- **Size and cost:** up to 720 lines tall, fewer when the avatar is small
  on the stage. At 30 frames a second, about 1.5 to 3 Mbit/s to each
  receiver.
- **Receiving it:** each new video frame is recombined for the stage while
  the window is drawn. A window out of sight (minimized) recombines one
  only when an output view needs it, at most 10 a second.
- **The limits:** receivers can't run its physics; it looks as good as
  the video; and it costs far more upload. On a full mesh of 6, one
  video-only participant sends 5 videos, so the tab warns above three
  people.
- **The default:** video only, for every model. Sharing is chosen per
  model and remembered; **video only, never its files** keeps a model to video for
  good.

## 4. The network

**Peer to peer.** Each participant connects to each other one: a full
mesh of up to 15 connections. That is light for data; video is the costly
part, and the warning above keeps it in bounds.

**The signaling server** introduces apps to each other:

- **What it does:** it relays offers, answers and ICE candidates between
  the apps of a room; it holds the room's door (knock, let in, decline,
  lock, remove, the door token); and it hands out short-lived TURN
  credentials.
- **What it never sees:** the invitation's secret, nicknames in clear
  (they're encrypted with the session key), passwords, any parameter, any
  chat message or any model.
- **What it keeps:** rooms in memory only, expiring after 12 hours. Its
  log has counts only.

**The relay (TURN).**

- **Why:** some networks (strict NATs, company and school networks)
  block direct connections; without a relay, those people can't join.
- **Hiding addresses:** WebRTC tells each peer the other's IP address.
  **Hide my address** (on by default) makes each app connect only through
  the relay, so the others never see it. With it on and no relay on the
  server, the app says so and doesn't connect.
- **Its cost:** data-only sessions cost a relay little, about 120 kbit/s a
  person; video-only models through it cost much more.

## Hosting a server

**Running the included server** (Node 22 or later):

```sh
npm ci
npm run collab:server
```

It listens on `127.0.0.1:8790`: the WebSocket at `/ws`, the join page at
`/join/<room>`, and counts at `/health`. Settings, as environment
variables:

| Variable                                                                                       | Default     | Meaning                                                                                                                           |
| ---------------------------------------------------------------------------------------------- | ----------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `PORT`                                                                                         | `8790`      | The port.                                                                                                                         |
| `HOST`                                                                                         | `127.0.0.1` | The address to listen on. `0.0.0.0` behind a TLS proxy.                                                                           |
| `STUN_URLS`                                                                                    | none        | Comma-separated `stun:` URLs, given to the apps as they are.                                                                      |
| `TURN_URLS`                                                                                    | none        | Comma-separated `turn:` or `turns:` URLs of a TURN server.                                                                        |
| `TURN_SECRET`                                                                                  | none        | The TURN server's shared secret. The server hands out short-lived credentials in the TURN REST form (coturn's `use-auth-secret`). |
| `TRUST_PROXY`                                                                                  | off         | `1` behind a TLS proxy: the limits per address read its `X-Forwarded-For`.                                                        |
| `LIMIT_CONNECTIONS_PER_ADDRESS`, `LIMIT_ROOMS_PER_ADDRESS`, `LIMIT_NEW_CONNECTIONS_PER_MINUTE` | 20, 6, 60   | The limits per address (below).                                                                                                   |

**The limits,** the same on both servers (`src/core/collab/limits.ts`), so
that one address can't drain a server (or a free plan's requests):

- **A message:** at most 64 KiB, and a signal at most 32 000 characters;
- **A connection:** at most 200 messages a second;
- **One address:** at most 20 open connections, 6 rooms at once (hosting
  or joining), and 60 new connections a minute. Past them, the app says
  the server is busy for its address.

**For people on other networks,** put it behind a TLS proxy (for example
Caddy or nginx) on a domain, so the apps reach it as `wss://<domain>/ws`,
and run a TURN server beside it (for example coturn with
`use-auth-secret` and the same secret). Without TURN, people on strict
networks can't join, and **Hide my address** can't work.

### Run it on Cloudflare

The same server runs as a Cloudflare Worker (`collab/worker/`):

- **A Durable Object per room,** with WebSocket hibernation: between
  messages a room sleeps and costs nothing, its state in the object's
  storage; an alarm wakes it for the 60-second grace and the 12-hour
  expiry. When a room ends, its storage is deleted.
- **The limits per address** are counted in a Durable Object named after
  a hash of the address; the address itself is not stored.
- **The relay** is Cloudflare's TURN service: the Worker asks it for
  short-lived credentials (13 hours, past a room's 12) with a TURN key held
  as a Worker secret, and gives them to room members only.
- **No logs:** the Worker writes none, and its configuration turns off
  Workers Logs (on by default for new Workers) and Logpush. Cloudflare
  still keeps its usual aggregate metrics for the account (requests,
  errors, CPU time) and handles the traffic under its own privacy policy.

**Try it locally,** with no account (Miniflare, Cloudflare's local
runtime):

```sh
npm ci
npm run collab:worker     # ws://127.0.0.1:8791/ws
```

**Deploy it,** on a hostname of a domain in your Cloudflare account:

1. In Cloudflare's dashboard, make a **TURN key** (Realtime → TURN
   Server), and keep its id and API token.
2. Make an **API token** for deploys (My Profile → API Tokens → Create
   Token) from the **Edit Cloudflare Workers** template, with its
   resources limited to your account and the zone of your hostname, and
   note your **account id**. (Cloudflare's documentation names this
   template for deploys from CI; whether a narrower token, such as
   _Workers Scripts: Edit_ with _Workers Routes: Edit_, is enough for a
   custom domain is not confirmed.)
3. Set the TURN key as Worker secrets, from a clone, logged in with
   `npx wrangler login` or with the token in `CLOUDFLARE_API_TOKEN`:

   ```sh
   cd collab/worker
   npx wrangler secret put TURN_KEY_ID
   npx wrangler secret put TURN_KEY_API_TOKEN
   ```

   (The first `wrangler secret put` creates the Worker, empty, if it
   doesn't exist yet; the deploy fills it.)

4. **From GitHub:** add the secrets `CLOUDFLARE_API_TOKEN` and
   `CLOUDFLARE_ACCOUNT_ID` and the variable `COLLAB_HOST` (the hostname,
   such as `collab.example.com`), then run **Actions → Deploy the
   signaling Worker**. It runs the protocol tests against the Worker
   first, deploys it with the hostname as a custom domain, and checks
   `https://<hostname>/health`.
   **By hand:** add a `[[routes]]` entry with your hostname and
   `custom_domain = true` to a copy of `collab/worker/wrangler.toml`, and
   `npx wrangler deploy --config <that copy>`.
5. In Mochi Studio, set **Signaling server** to `wss://<hostname>/ws`.

The limits and the relay credentials' lifetime are variables in
`wrangler.toml` (`LIMIT_…`, `TURN_TTL`). If you run a server for other
people, publish a privacy notice for it; [PRIVACY.md](../PRIVACY.md) is one
to start from.

### Ways to host

**Three ways to host,** with what each asks:

| Option                                                                                                                   | What it asks                                                                                                                                                                              | Cost                                                                                                                                                       |
| ------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **A. A serverless host:** the signaling server as a serverless function with per-room state, and the host's TURN service | An account with the provider. The included Worker runs on Cloudflare ([above](#run-it-on-cloudflare)); another provider needs a port. No machine to keep updated.                         | Signaling at this scale fits most free plans (a room is a few messages a second). TURN is usually priced per GB, so video through the relay is what costs. |
| **B. A small server of your own:** a VPS running the included server under Node, a TLS proxy, and coturn                 | A VPS, a domain, and keeping the system updated.                                                                                                                                          | A small VPS, a few euros or dollars a month, usually with plenty of traffic included.                                                                      |
| **C. One participant's computer:** the included server on the host's own machine                                         | The guests must reach it, so a forwarded port or a public address, which most home connections lack. Without a relay, people on strict networks can't join and addresses can't be hidden. | Nothing.                                                                                                                                                   |

Check the providers' current price lists before choosing: free
allowances and prices change.

## 5. Privacy and moderation

- **Nicknames only:** no accounts, emails or friend lists; a nickname is
  chosen per session.
- **IP addresses:** hidden from the other participants by default,
  through the relay.
- **The host's controls,** enforced by the server: let in, decline, lock,
  make a new link, and **remove**: the server drops the person's
  connection and refuses their app again for the session, and every app
  closes its connections to them and deletes their shared files. They see
  "You were removed from the session."
- **Anyone's controls:** hide and block, on their own screen only.
- **Private details** (the link and the code) are behind **Show
  invitation** and **Show code**, which hide them again after 30 seconds.
- **What you share is yours to share:** see [TERMS.md](../TERMS.md).

## 6. Testing

- **Unit tests** of the protocol: the rooms and their door, parameter
  packing and deltas, smoothing, the order, the invitation link and code,
  the password proof, and file encryption.
- **Both servers, the same tests:** `test/unit/signaling.test.ts` runs the
  protocol and the limits against the Node server and against the Worker
  under Miniflare, with Cloudflare's TURN API stood in. The browser tests
  below run against either (`MOCHI_COLLAB_SERVER=worker` for the Worker).
- **A local signaling server** starts in the browser tests, with three app
  pages, each with a synthetic model, in one room (Chromium's WebRTC works
  between pages without a network). They check parameters, positions and
  order, hide, block, remove, lock, leave, reconnecting, shared models
  arriving and being deleted, a video-only avatar's picture and alpha (and
  that no model bytes are sent), an output view, the code and password, a
  new link, chat, and placing others by hand.
- **The relay:** a test checks that with **Hide my address** on, WebRTC is
  asked for relay candidates only, with the server's credentials.

## Sources

- WebRTC (W3C; RFC 8825 to 8835), TURN (RFC 8656) and its REST
  credentials, WebCrypto (HKDF, AES-GCM, HMAC), and Crockford's base32.
- The model settings file's `ParametersExcludedFromVNetSmoothing` list.

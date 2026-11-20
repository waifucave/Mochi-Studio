# Privacy notice: the collaboration signaling server

This notice is for a Mochi Studio signaling server: the service that
introduces the apps of a collaboration to each other. It describes the
server as Mochi Studio's code runs it (`collab/`), on Cloudflare. Whoever
runs a server puts their name and contact below.

- **Operator:** `[name of the operator]`
- **Contact:** `[contact address]`

Mochi Studio itself sets no signaling server and sends nothing anywhere
until you choose a server in **Settings → Collab** and start or join a
session.

## What the server sees

- **Room ids:** random numbers your app makes for each session.
- **Nicknames, encrypted:** your app encrypts your nickname (and a room
  password's proof, if the host set one) with a key from the invitation's
  secret. The server passes them on without being able to read them. The
  secret, after the `#` of the invitation link, never reaches the server.
- **Connection details:** when your app connects and disconnects, and your
  IP address, as any web server sees them. The server uses the address
  only to count connections per address, under a one-way hash of it, to
  keep one address from overloading the service.
- **Connection setup:** the offers, answers and network candidates your
  app and the others' apps exchange to connect directly (WebRTC). They
  contain network addresses, which is why **Hide my address** (on by
  default) gives only the relay's.
- **Not your stream:** your avatar's movements, model files, video and
  chat go between the apps, encrypted, not through the signaling server.
  With **Hide my address** on, they go through the relay (TURN), which
  passes them on encrypted and cannot read them.

## What it stores, and for how long

- **While a room is open:** the room's state (its id, the encrypted
  nicknames, who is in it, the invitation's door token, and the hashed
  addresses' counts), so the room survives quiet moments.
- **After a room ends** (the host leaves, it reaches 12 hours, or the host
  doesn't come back within a minute): the room's state is deleted. A
  hashed address's count is deleted once it has nothing open and a minute
  has passed.
- **Logs:** the server writes none. Workers Logs and Logpush are turned off
  in its configuration.
- **Counts:** the number of rooms, participants and knocks at a time, with
  nothing about anyone, shown at `/health`.

## Who processes it

- **Cloudflare, Inc.** runs the server (Workers and Durable Objects) and
  the relay (Cloudflare's TURN service) for the operator. Cloudflare keeps
  aggregate metrics for the account (request counts, errors, processing
  time) and handles network traffic, including IP addresses, under its own
  privacy policy: <https://www.cloudflare.com/privacypolicy/>.
- **No one else:** the operator receives no personal data beyond the
  above, sells nothing and shares nothing.

## Why

To run the collaboration you start or join: introducing the apps,
relaying their connection when a direct one is not possible, and keeping
the service available for everyone.

## Your choices and rights

- You can use Mochi Studio without collaboration, or with a signaling
  server you run yourself.
- Depending on where you live, you may have rights to ask what is held
  about you, to correct it or to delete it. The server holds nothing about
  you once your room ends; for anything else, write to the contact above.

## Changes

This notice may change with the service. The version shown by the
operator applies.

# Contributing to Mochi Studio

Thank you for helping. This page says how to build and test, how to sign
off your work, and the one statement every contribution needs.

## Building and testing

With Node.js 22.18 or later:

```sh
npm ci
npm run fetch:models   # MediaPipe's face and hand models, once
npm run dev            # the app in a browser, at the address Vite prints
```

Before you send a change:

```sh
npm run check          # formatting, type checks and the unit tests
npm run test:browser   # build, then the browser tests in headless Chromium
```

- **Browser tests** need Chromium; set `CHROMIUM_PATH` to use an installed
  one.
- **Test counts:** the suites run every `*.test.ts` file in `src/` and
  `test/`, whether git tracks it or not. Before you quote a count, check
  that `git status --short src test` lists no new test files, or the count
  includes tests nobody else has.
- **The desktop app:** `npm run desktop`; see [docs/desktop.md](docs/desktop.md)
  for packages and the native modules (Spout2 on Windows, the virtual camera
  on Linux).
- **Agent commands:** after changing one, `npm run agent:catalog` updates
  `bridge/catalog.json` and the command table in `docs/agent-api.md`.
- **Dependencies:** after adding or updating one that ships,
  `npm run notices` rewrites `THIRD_PARTY_NOTICES.md`; a test checks it.
- **Never commit model data.** Put test models in `assets/models/` (ignored
  by git). The tests use a synthetic model built in code
  (`test/support/syntheticModel.ts`).
- **Formatting** is Prettier's (`npm run format`).

## Signing off (DCO)

Every commit must be signed off under the
[Developer Certificate of Origin 1.1](https://developercertificate.org/):
by signing off, you certify that you wrote the change or otherwise have
the right to submit it under the project's license. Add the line with
`git commit -s`:

```
Signed-off-by: Your Name <you@example.com>
```

## The clean-room statement

Mochi Studio is written without Live2D's code or documentation, through the
clean-room process described in [CLEANROOM.md](CLEANROOM.md). Every pull
request must include this statement, confirmed by its author:

> I have not viewed, decompiled or copied Live2D's SDK, Cubism Core,
> Framework, sample code or manuals, or third-party `.moc3`
> implementations, for this contribution.

Please also do not copy code, interface text or artwork from other avatar
apps. Where Mochi Studio works with files or plugins made for another app,
it follows that format's public documentation.

## Pull requests

- Keep a change to one subject, with tests for what it changes.
- Say what you changed and why, and how you tested it.
- Changes to what the app sends, stores or exposes (the network, files,
  agents, plugins) need a word on privacy and security; see
  [SECURITY.md](SECURITY.md).

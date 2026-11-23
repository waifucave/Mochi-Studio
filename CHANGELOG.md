# Changelog

Mochi Studio's versions, newest first. Each version's release notes are in
[docs/releases/](docs/releases/).

## 0.1.0

The first pre-release. The desktop app's packages for Linux, Windows and
macOS are not signed.

- **A working app,** in the browser and as an unsigned desktop app for
  Linux, Windows and macOS, on Mochi2D 0.24.1.
- **Built and tested:** face, hand and voice tracking, items, hotkeys, the
  settings import, the plugin API, the agent API, Spout2 output (Windows),
  a virtual camera (Linux) and collaborations.
- **The virtual camera on Windows 10 and 11** is built and tested end to
  end on GitHub's Windows runner (Windows Server 2025), not yet on a
  person's PC or in call apps.
- **On macOS** it is built and its core tested, unsigned; it runs only in a
  signed build.
- **The window keeps answering** whatever Spout2, the virtual camera or a
  web item costs: on a computer that can't keep up, their frame rate comes
  down instead, and the app says so once.
- **A lost graphics context** (a graphics driver or the app's graphics
  process restarting) no longer fails a model being loaded: the load waits
  for the context to be back, and the log says what happened.
- **The app's own icon** in every package and window.
- **Not yet:** signed builds.
- **No signaling server is set or run.** Collaborations need one: the app
  sets none, and the project runs none. Run your own, or use one someone
  you trust runs ([docs/collaboration.md](docs/collaboration.md#hosting-a-server)).

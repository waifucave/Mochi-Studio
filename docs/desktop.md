# Mochi Studio desktop

The desktop app is Mochi Studio in its own window, with the bridge built in:
no separate `npm run bridge`, and no pairing.

- **OBS:** the address in the Camera tab works exactly as with the separate
  bridge: `http://127.0.0.1:47830/app/output.html?bridge=…&view=…`. Add it
  as a Browser Source. The app must be running.
- **Agents:** turn on **Agent access** in the settings' General tab, create a token, and
  set up MCP clients as in [agent-api.md](agent-api.md). The MCP server
  (`… bridge/bin.mjs mcp`) joins the app's bridge.
- **Model folders:** **Open folder…** opens the system's folder dialog. The
  app's bridge then serves that folder's files to OBS views straight from
  disk, with no upload, so views are ready as fast as the disk allows. Zips,
  URLs and dropped folders are uploaded to the bridge as in the browser.
- **Recent models:** folders and zips opened with **Open folder…** and
  **Open zip…** (the app's own dialogs) are remembered (the last ten). They are offered on the empty stage and in the Model tab.
  The last one opens again when the app starts; turn that off with **Reopen
  the last model when the app starts** (Model tab). A folder that has moved,
  been renamed or deleted, or whose drive is not connected, gets a message
  saying so; open it again from its new place, or remove it from the list
  (the folder itself is not touched). The list is `recent-models.json` in
  the app's data folder.
- **Hotkeys in other apps:** see below.
- **The mouse anywhere on the screen:** the mouse inputs
  (`MousePositionX`, `MousePositionY`) follow the pointer over other apps
  too, measured from the middle of the main screen or of the one chosen in
  the Camera tab; the app reads it about
  60 times a second ([user-guide.md](user-guide.md#mouse-and-controller)).
- **Light from the screen:** the Camera tab lists the screens and windows
  the app can capture for the light overlay; one is captured only after you
  press Start, and only its average colors are used
  ([user-guide.md](user-guide.md#light-from-the-screen)). macOS asks for
  the screen-recording permission the first time.
- **Web items:** a web page (a chat, an alert box) drawn as an item, in
  the desktop app only. The page runs in a hidden, sandboxed, muted window
  with a storage of its own and every permission refused; it cannot open
  windows, download, leave its site or load the app's own addresses
  ([user-guide.md](user-guide.md#web-items-desktop-app)). Output views get
  its frames from the app.
- **Spout2 (Windows):** the Camera tab's **Spout2** section sends the avatar
  to OBS's Spout2 plugin and other Spout2 programs on this computer: up to
  four senders, named `MochiStudio`, `MochiStudio2` and so on, transparent,
  with premultiplied color ([user-guide.md](user-guide.md#obs-with-spout2-windows-desktop-app)).
  Each is the app's output view drawn off screen, without the user interface.
  The Spout2 SDK (BSD-2-Clause) is compiled into the app's Spout2 module
  ([THIRD_PARTY_NOTICES.md](../THIRD_PARTY_NOTICES.md)).
  - **Measured** on GitHub's Windows runner, which has no graphics card, so
    every frame went through memory (readback), with the control window
    minimized, a moving head and one 960 × 540 output: the app's processes
    used 6.5% of one core with Spout2 off, 67% at 60 frames a second, and
    35% with readback at its limit of 30 frames a second. With a graphics
    card, frames stay on the card (the GPU path), which this runner cannot
    show; that costs far less, and is still to be measured on a real
    machine.
  - **Larger than the screen** (1920 × 1080 on the runner's 1024 × 720):
    drawn at its own size, Windows kept the window to the screen's size; drawn
    smaller and scaled up, the frames had the right size but stayed empty.
    Both are without a graphics card; until they are checked on one, pick a
    size that fits the screen.
- **A virtual camera (Linux):** the Camera tab's **Virtual camera** section
  sends the avatar as "Mochi Studio Camera" through a v4l2loopback device,
  for call apps ([user-guide.md](user-guide.md#a-virtual-camera-for-calls-linux-desktop-app),
  [virtual-camera.md](virtual-camera.md)). Windows and macOS follow.
- **In the background:** the window keeps working while it is minimized or
  covered, so OBS views keep moving (a browser slows a hidden page down,
  and Mochi Studio keeps its output views fed from a worker's timer then).
  Out of sight, it doesn't draw its own stage. Motions, expressions,
  physics, lip sync, plugins and the output views all keep their frame
  rate, and the graphics card's time goes to OBS and the game. Shown again,
  it draws the current pose at once.
- **Plugins:** the plugin server for plugins made for VTube Studio runs in
  the app's bridge; switch it on in the settings' General tab ([plugins.md](plugins.md)).
- **Phone tracker:** a phone on the same network can track the face; the
  app's bridge serves the phone page when **Phone tracker** is on in the
  Camera tab ([user-guide.md](user-guide.md#a-phone-as-the-face-tracker)).
  It is the only part of the app that listens beyond this computer: port
  27890 (or the next free one) while it is on, nothing while it is off.
  The first time, Windows and macOS ask whether the app may accept
  incoming connections: allow private networks only. Approved phones, the
  certificate and its key are in the bridge's folder (`phones.json`,
  `phone-tls.json`).
- **Port:** 47830, or set the environment variable `MOCHI_STUDIO_PORT`. If a
  bridge started with `npm run bridge` already uses the port, the app says
  so and quits: stop that bridge first, since the app runs its own.
- **Data:** settings stay in the app's own browser storage. Tokens and the
  view key are in the same folder as the separate bridge's
  (`~/.config/mochi-studio-bridge/`, or `MOCHI_STUDIO_BRIDGE_HOME`), so tokens
  made for one work with the other.

## Hotkeys in other apps

In the desktop app, hotkeys also work while another app (a game, OBS) has
focus. **Hotkeys also work while another app has focus** in the Hotkeys tab
turns this off. Below the switch, each hotkey says whether it works in
other apps, or why it works only in Mochi Studio's window:

- **Several keys held together** (`Q+W`): a system shortcut is modifiers plus
  one key.
- **On while held**: the system does not tell the app when the key is let go.
- **Mouse buttons**: system shortcuts are keys only.
- **A typing key without Ctrl, Alt or Cmd/Win** (a letter, a digit, Space…):
  registered with the system, it would be taken from every other app, so
  typing that key in a game's chat would fire the hotkey instead. Add a
  modifier, or use F13–F24 (many stream decks send these) or the numeric
  keypad.
- **Taken:** the system or another app already uses the combination. Choose
  another, or free it in that app.

Window hotkeys follow the key's position on the keyboard. A hotkey
registered with the system names the key by its US-layout character, so on
another layout a letter or punctuation key may be a different physical key;
F-keys, the keypad and arrows are the same on every layout.

## Builds

The builds are **unsigned**. Windows SmartScreen and macOS Gatekeeper warn
about unsigned apps. Each package from the workflow comes with a
`HOW-TO-OPEN.txt` saying what the warnings mean on that system and how to
get past them (`desktop/how-to-open/`). In short:

- **Windows:** unzip `Mochi Studio-<version>-win.zip` and run
  `Mochi Studio.exe`. At the SmartScreen notice, choose "More info", then
  "Run anyway".
- **macOS:** unzip, move the app to Applications, then right-click it and
  choose "Open" the first time. Or, in a terminal:

  ```sh
  xattr -dr com.apple.quarantine "/Applications/Mochi Studio.app"
  ```

- **Linux:** `chmod +x "Mochi Studio-<version>.AppImage"`, then run it.

**Licenses in every package:** beside the executable (on macOS, in the
app's `Contents` folder) are `LICENSE.mochi-studio.txt`,
`THIRD_PARTY_NOTICES.md` (every third-party package in the app, with its
license text), and Electron's own `LICENSE.electron.txt` and
`LICENSES.chromium.html`. `npm run notices` writes the notices from what
the build bundles, and a test checks they are up to date.

## Packages from CI

The **Desktop packages** workflow (`.github/workflows/desktop.yml`) builds
the Linux, Windows and macOS packages on GitHub's runners. It is started by
hand (Actions → Desktop packages → Run workflow) or by a version tag, and
attaches the packages to the run as artifacts for 14 days. It publishes no
release.

## Building it yourself

In a clone, with Node 22.18 or later:

```sh
npm install                 # downloads Electron's binary too
npm run desktop             # builds and starts the app
npm run desktop:package     # builds the packages into desktop/dist/release/
```

`desktop:package` builds an AppImage and an unpacked folder on Linux, and
zip files for Windows and macOS (`desktop/electron-builder.json`). It does
not sign anything.

On Windows, for Spout2, build the Spout2 module first (Visual Studio's C++
build tools and Python, as node-gyp needs):

```sh
npm run fetch:spout   # the Spout2 SDK at its pinned commit, into native/spout/third_party/
npm run build:spout   # native/spout/build/Release/mochi_spout.node
```

`desktop/build.mjs` copies the module into the app, and the package keeps it
outside the app's archive. Without it, the Spout2 section says this build
has no Spout2 module. The test (`test/browser/spout.test.ts`, with
`MOCHI_SPOUT_TEST=1`) runs on the Windows runner of `desktop.yml`.

On Linux, for the virtual camera, build its module (a C compiler, Python and
the kernel's V4L2 headers, `linux-libc-dev`, as node-gyp needs):

```sh
npm run build:v4l2    # native/v4l2/build/Release/mochi_v4l2.node
```

`desktop/build.mjs` copies it into the app as well. Its tests:

- `src/core/virtualCamera.test.ts`: the conversion, the writer against a
  fake device, and the module's conversion against the reference, byte for
  byte;
- `test/browser/vcam.test.ts` with `MOCHI_DESKTOP_TEST=1`: the app writes to
  a fake device (a file, `MOCHI_VCAM_FAKE_DEVICE`), and the test reads the
  frames;
- the same with `MOCHI_VCAM_TEST=1` and a loaded v4l2loopback device: ffmpeg
  reads the camera as an app would. The `vcam` job of `desktop.yml` loads the
  module and runs it.

How it is put together:

- `desktop/main.ts`, the Electron main process, is bundled with the bridge
  (`bridge/src/`) by `desktop/build.mjs` into `desktop/dist/app/main.cjs`.
- The built pages (`dist/`) are copied next to it. The bridge serves them at
  `/app/`, so the window and the OBS address load from
  `http://127.0.0.1:<port>`, which the bridge's origin checks allow.
- At start, the app pairs its own window with the bridge. It passes the host
  token in the address's fragment, which the page stores and then removes
  from the address. Output views through the bridge are always on in the
  app; agent access stays off until the person turns it on.
- The camera and microphone are allowed for the app's own pages only. Links
  to other sites open in the normal browser.
- A preload script (`desktop/preload.ts`) gives the app's own pages one
  addition, `mochiDesktop.openFolder()`. It shows the folder dialog; the
  main process lists the folder and registers it with the bridge, which
  serves it at `/disk/<id>/…` to the page and, through `disk_source`, to
  views ([agent-api.md](agent-api.md)).

The desktop test (`test/browser/desktop.test.ts`) starts the built app with
Playwright. It needs a display (`xvfb-run` on Linux), the Electron binary,
and `npm run desktop:build`:

```sh
MOCHI_DESKTOP_TEST=1 xvfb-run -a npx vitest run --project browser test/browser/desktop.test.ts
```

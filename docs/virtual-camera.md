# The virtual camera: design

A design for Mochi Studio's virtual camera, written before any code. It turns the avatar into a camera that video-call and
streaming apps can open: Discord, Zoom, Teams, Meet in a browser, and OBS.

**Status:** Linux is built. Two changes from this design:

- **The conversion** runs in the native module, at 2 ms for a 1280 × 720
  frame, instead of a WebGL pass. Linux needs YUYV, and the module writes
  it anyway. `src/core/yuv.ts` is the reference, and the module matches it
  byte for byte. The GPU pass waits for NV12 on Windows and macOS.
- **On GitHub's Linux runner** (`desktop.yml`, the `vcam` job): the module
  converts a 1280 × 720 frame in 1.7 to 2.9 ms (the JavaScript reference:
  3.3 to 6.4 ms), and the test with a real v4l2loopback device, read by
  `ffmpeg` as a camera app would, passes: size, colors, background, mirror,
  and the device released when switched off.
- **The still card** while nothing is sent isn't built yet. On Linux, the
  device closes, and apps show their own "no camera" picture.

Windows and macOS are still to do.

Marks used below:

- **To check:** facts not yet confirmed, each with the test that
  settles it.
- Everything else is the design or is documented platform behavior.

## What the person sees

- **Where:** a section in the Camera tab, after Spout2. It has a
  **Virtual camera** switch, **Mirror**, a size, and a background choice.
  - On Windows and macOS, it also has **Install** and **Uninstall**
    buttons.
  - On Linux, it has setup instructions instead (see below).
- **The name:** other apps list a camera called **Mochi Studio Camera**.
  - It is one camera. A second Mochi Studio window can't send to it while
    the first one does, and its status line says so.
- **When nothing is sent:** apps that open the camera while Mochi Studio
  is closed, or while the switch is off, see a still card ("Mochi Studio
  isn't sending") rather than black or an error. People then know which
  app to start.
- **For agents:** `get_state.virtualCamera` (installed, on, size, mirror,
  errors) and `set_virtual_camera`, as for Spout2.

## The frames, on every platform

The camera reuses the Spout2 output's frame path (`desktop/spout.ts`):

1. **Rendering:** a hidden offscreen window renders the app's own output
   view (`output.html`) at the camera's size and frame rate, without the
   rest of the window.
2. **Background:** the page doesn't get `?transparent=1`. The camera gets
   a background (see Transparency).
3. **Mirror:** `?mirror=1` when Mirror is on.
4. **The frames:** each paint event gives the frame, as a shared texture
   where the GPU allows it and as a bitmap otherwise.
5. **To the platform:**
   - **Windows:** a camera source that runs in another process gets the
     frames (see each platform).
   - **Linux:** the frames are written to the loopback device.
   - **macOS:** the frames go to the Camera Extension.

**Pixel format.** Cameras deliver video formats, not RGBA.

- **Format:** NV12 is offered first everywhere, then YUY2 (YUYV on Linux),
  plus RGB32 on Windows for apps that want RGB.
- **Conversion:** BGRA to NV12 runs on the GPU, as a WebGL pass in the
  output page, so the CPU doesn't convert 30 frames a second.
  - **Color:** BT.709 matrix, limited range, which video apps expect for
    HD.
  - **Fallback:** without the GPU, the conversion runs in the native
    module.

**Size and rate.** Apps choose from a fixed list of formats that the camera
announces, so a camera can't follow window resizes the way Spout2 does.

- **Sizes:** 1280 × 720 (the default) and 1920 × 1080, both 16:9, and
  960 × 540 for slow machines. One setting picks the size; the others
  stay on the list.
- **Rate:** 30 frames a second, with 60 as an option.
- **Framing:** the stage is fitted inside the frame, as `outputPosition`
  does for Spout2 at a fixed size, with the background around it.

**Transparency.** Most video apps show no alpha, and NV12 and YUY2 have
none. So the camera always has a background:

- **The stage's background** (the default): the color or picture the
  stage shows. What people see in the app is what the call sees.
- **A solid color:** for keying in apps that can key. Green `#00B140` is
  the preset.
- **RGB32 with alpha (Windows):** some apps, OBS among them, may read an
  alpha channel from an RGB32 format. To check, with the test at the end.
  - For transparency in OBS, Spout2 (Windows) or an output view (all
    platforms) is still the documented way.

**Mirror.** Off by default.

- **Why:** call apps mirror the self-view on the person's own screen, but
  send the picture unmirrored, so others read text the right way round.
  Mirroring the camera too would make the person's own preview look
  unmirrored.
- **The hint:** the switch says so.

## Windows

Two kinds of virtual camera exist. The plan is to build both.

### Media Foundation virtual camera (Windows 11)

- **What it is:** an app calls `MFCreateVirtualCamera` (Windows 11, build
  22000 or later) to register a software camera. Its frames come from a
  Media Foundation media source, a COM class in a DLL that the app ships.
  - **The process:** Windows' Camera Frame Server service loads that DLL,
    not the app.
  - **Lifetime:** with session lifetime, the camera exists while Mochi
    Studio holds it, and vanishes when the app quits. With system
    lifetime, it stays until it's removed.
- **Which apps see it:** apps that use Media Foundation or WinRT
  `MediaCapture`, such as the Windows Camera app, Teams and Chromium-based
  browsers.
  - **To check:** whether DirectShow apps (OBS's Video Capture Device,
    older Zoom builds) list it.
- **What it installs:**
  - **Nothing for the camera itself:** no driver, and no reboot.
  - **The DLL's COM registration:** the Frame Server, a service, has to
    find the class.
  - **To check:** whether a registration under `HKCU` is enough when the
    camera has current-user access, or whether `HKLM` is needed. `HKLM`
    needs administrator rights once, at Install.
- **Administrator rights:**
  - **Needed for:** all-users access.
  - **Not needed for:** current-user access, besides the registration
    question above.
- **The frames:** the media source runs in the service's process, so it
  reads them from the app:
  - **The channel:** a named shared-memory ring of three frames, with an
    event for each new frame.
  - **Writing:** the app's native module writes NV12 there.
  - **Reading:** the media source wraps it in `IMFSample`s.
  - **Shared D3D textures** across the service boundary are possible, but
    they depend on the GPU and the session. The first version copies
    through memory: about 3 MB a frame at 1280 × 720.

### DirectShow source filter (Windows 10 and 11)

- **What it is:** a COM DLL registered in the video input category, which
  every DirectShow app enumerates. It runs inside each app that opens the
  camera.
- **Which apps see it:**
  - DirectShow apps: OBS, Zoom, Discord's desktop app, many older tools.
  - Chromium also lists DirectShow cameras next to Media Foundation ones.
  - **To check:** each app on a current Windows 11. Apps built only on
    `MediaCapture` don't see it.
- **What it installs:** the DLL, in 32-bit and 64-bit builds (32-bit apps
  load the 32-bit one), with `regsvr32` registration.
- **Administrator rights:** yes, once at Install, for the registration
  under `HKLM`, which is where every app finds it. Uninstall unregisters
  it.
- **The frames:** the same shared-memory ring, read in each app's process.
  Several apps can open the camera at once.

### The choice for Windows

- **Ship both, from one native module:**
  - Windows 11 creates the Media Foundation camera;
  - the DirectShow filter covers Windows 10 and apps that only enumerate
    DirectShow.
- **Avoiding two cameras:** if a DirectShow app also lists the Media
  Foundation camera, the same machine would show two "Mochi Studio
  Camera" entries. The test below settles this. If it happens, Windows 11
  installs only the Media Foundation camera, unless the person asks for
  the other in the settings.
- **Install:** one press, with one administrator prompt (UAC) for the
  registrations. It never needs Mochi Studio itself to run as
  administrator.
- **Code:** C++ like the Spout2 addon, as two DLLs (the media source, the
  filter) and the Node-API module that writes the ring.
  - The filter is written from the DirectShow interfaces. It uses no
    base-class samples from elsewhere.

## Linux

- **What it is:** the `v4l2loopback` kernel module creates a video device
  (`/dev/videoN`). Mochi Studio writes frames to it, and every V4L2 app
  reads it as a camera: browsers, OBS, Zoom, Discord.
- **What the person installs,** once:
  1. **The module:** `v4l2loopback-dkms` from their distribution. The
     settings link the commands for Debian/Ubuntu, Fedora and Arch.
  2. **Loading it:** the app shows the line to copy:

     ```sh
     sudo modprobe v4l2loopback devices=1 video_nr=10 card_label="Mochi Studio Camera" exclusive_caps=1
     ```

     - **`exclusive_caps=1`** makes the device announce itself as a
       capture device only while something writes. Chromium-based apps
       need that to list it.
     - **To load it at every start:** a line in `/etc/modules-load.d/`
       and one in `/etc/modprobe.d/`. The guide gives both.

  3. **With Secure Boot,** the DKMS module must be signed with a key
     enrolled through MOK. Distributions guide this at install. The user
     guide says so.
- **Administrator rights:** yes, for installing and loading the module
  (`sudo`). The app never asks for them itself.
  - Writing to the device needs only the `video` group, which desktop
    users normally have.
- **Finding the device:** the app looks for a loopback device whose card
  label is "Mochi Studio Camera" and writes to the first one. Without
  one, the section shows the steps above.
- **The frames:** a small Node-API module in C:
  1. opens the device;
  2. sets the format with `VIDIOC_S_FMT` on an output buffer (YUYV, at the
     chosen size);
  3. writes each frame with `write()`.

  YUYV is the format V4L2 apps accept most widely.

- **Later:** a PipeWire video source, for apps that read cameras through
  PipeWire. It needs no kernel module. It isn't in this design because
  call apps still mostly read V4L2.

## macOS

- **What it is:** a Camera Extension (Core Media I/O extension, macOS
  12.3 or later). It's a system extension inside the app bundle, at
  `Contents/Library/SystemExtensions/`. It's written in Swift.
  - **Activation:** the app asks to activate it (`OSSystemExtensionRequest`),
    and the person approves once in System Settings.
  - **Which apps see it:** all apps that use AVFoundation (FaceTime, Zoom,
    Teams, browsers and OBS), with no driver.
- **The frames:** the extension offers two streams:
  - a source stream, which apps read;
  - a sink stream, into which Mochi Studio writes NV12 `CMSampleBuffer`s
    from IOSurfaces, through Core Media I/O. A small native module does
    this.

  This is Apple's documented pattern for app-fed camera extensions. No
  shared memory needs to be set up.

- **Development build, unsigned:**
  - **Build:** `xcodebuild` with `CODE_SIGNING_ALLOWED=NO` builds the
    extension.
  - **Loading it** needs a Mac with System Integrity Protection off and
    `systemextensionsctl developer on`. The bundle can then be anywhere.
  - **The docs** say this clearly. It's for development only.
- **Release build, signed and notarized in CI:** the app moves to the
  project's Developer ID.
  - **Secrets that already exist:** `MAC_CERTIFICATE_P12_BASE64`,
    `MAC_CERTIFICATE_PASSWORD`, `MAC_SIGNING_IDENTITY`, `APPLE_ID`,
    `APPLE_TEAM_ID` and `APPLE_APP_PASSWORD`.
  - **What a maintainer sets up in one sitting** (developer.apple.com,
    Certificates, Identifiers & Profiles):
    1. **App ID for the app:** `org.mochistudio.desktop` (the `appId` in
       `desktop/electron-builder.json`), with the **System Extension**
       capability and the **App Groups** capability.
    2. **App ID for the extension:** `org.mochistudio.desktop.camera`.
       The extension's ID must begin with the app's. It needs the **App
       Groups** capability.
    3. **An App Group,** for example `group.org.mochistudio.desktop`,
       assigned to both App IDs.
       - The extension's Mach service name (`CMIOExtensionMachServiceName`
         in its `Info.plist`) must begin with an app group of the
         extension, written with the team prefix (`<TeamID>.…`).
       - **To check:** whether this form or the `group.` form is the one
         `codesign` and the system accept for Developer ID, on the macOS
         versions we support.
    4. **Two Developer ID provisioning profiles,** one per App ID. The
       System Extension entitlement is restricted, so it is valid only
       with a profile.
    5. **Two new secrets** for the profiles, for example
       `MAC_PROVISIONING_PROFILE_APP_BASE64` and
       `MAC_PROVISIONING_PROFILE_CAMERA_BASE64`.
  - **Entitlements:**

    | Bundle        | Entitlements                                                                                                                                                                       |
    | ------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
    | The app       | `com.apple.developer.system-extension.install`, `com.apple.security.application-groups` (the group), and the hardened runtime's existing ones (camera and microphone for tracking) |
    | The extension | `com.apple.security.app-sandbox` (camera extensions must be sandboxed), `com.apple.security.application-groups` (the group)                                                        |

  - **Signing order:**
    1. the extension, with its profile embedded;
    2. the native modules;
    3. the app, with its profile;
    4. notarize with `notarytool` (Apple ID, team and app password);
    5. staple.
  - **The `mac` section** of `electron-builder.json` gains the
    entitlements files, the profiles and the extension as extra files.
- **Install conditions:**
  - **Where:** macOS activates system extensions only for apps in
    `/Applications`. The section says so if the app runs elsewhere.
  - **Uninstall** deactivates the extension. Removing the app removes it
    too.
- **Administrator rights:** none from the app. The person approves the
  extension in System Settings, which may ask for their password.

## Tests on the runners

| Runner           | What can run                                                                                                                                                                                                                                                                                                                                                                                                              |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ubuntu-latest`  | **All of it.** Install `v4l2loopback-dkms` and the runner's extra kernel modules, then `sudo modprobe` with the line above. The app sends a known frame, `ffmpeg -f v4l2` reads one, and the test compares size, color (the BT.709 conversion within a tolerance), background and mirror. The module builds through DKMS and loads on the runner's kernel (checked); if it doesn't, the test is skipped with that reason. |
| `windows-latest` | **DirectShow:** the runner's user is an administrator, so `regsvr32` works. `ffmpeg -f dshow` reads a frame, compared as on Linux. **Media Foundation:** a test asks `MFCreateVirtualCamera` and reads the camera with a small Media Foundation reader. To check: Windows Server images may lack the Camera Frame Server. Then the test is skipped with that reason, and runs on a person's Windows 11.                   |
| `macos-latest`   | **Build only:** the extension builds unsigned, and its NV12 conversion and sink writer get unit tests against a fake sink. Activating a system extension needs a person's approval, or SIP off, which hosted runners don't allow. So reading the camera is a manual check on a maintainer's Mac, after the first signed build.                                                                                            |

Two checks to run once on a person's Windows 11:

1. **Which apps list each camera:**
   - **Apps:** OBS, Zoom, Discord, Teams, Chrome and the Camera app.
   - **Cameras:** the Media Foundation camera and the DirectShow filter.
   - **Settles:** the "To check" items above, and whether two entries
     appear.
2. **Whether OBS keeps alpha** from an RGB32 format.

## Order of work

1. The shared frame path:
   - the camera's offscreen window and the GPU NV12 pass;
   - the settings, the state and `set_virtual_camera`;
   - the Linux module, end to end with its runner test.
2. Windows: the DirectShow filter and its test, then the Media Foundation
   camera.
3. macOS: the extension, unsigned. Signing once the project has the App IDs,
   group and profiles.

## Sources

- What people expect from virtual cameras in avatar apps:
  - a camera named after the app;
  - one camera stream;
  - install and uninstall buttons;
  - a mirror switch;
  - administrator prompts at install on Windows.
- Platform documentation:
  - Microsoft's Media Foundation (`MFCreateVirtualCamera`) and DirectShow
    documentation;
  - the `v4l2loopback` README and the V4L2 API;
  - Apple's Core Media I/O extension and system extension documentation,
    and its code-signing and notarization guides.
- This design uses no other avatar app's code or wording.

# Testing on real hardware

The automated tests run in a container: headless Chromium, software WebGL,
a fake camera and microphone, and Linux only. This plan covers what they
cannot test. Each check says what to try, what to expect, and what to note.
Report the notes, with the computer (system, graphics card) and the
browser or app version, in one message or issue per session.

You need a model folder (DeepSeek-chan or your own) and OBS Studio 30 or
later.

## 1. First run (browser and desktop app)

Use a fresh browser profile (or, for the desktop app, delete its data
folder), so nothing is remembered.

| Try                                                      | Expect                                                                                            |
| -------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| Open Mochi Studio (`npm run dev`, or the desktop app)    | The "Getting started" card, with step 1 current, and an empty stage with Open folder… / Open zip… |
| Follow the card's steps only, without the docs           | Each step's button does the step; the next step becomes current                                   |
| Open a folder that is not a model (for example Pictures) | A message saying to choose the folder with the .model3.json file                                  |
| Hide the card, reload                                    | It stays hidden; the Guide button shows it again                                                  |

**Note:** any step where you were unsure what to do, and the wording that
would have helped.

## 2. Camera

| Try                                                         | Expect                                                                             |
| ----------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| Start camera; allow the permission                          | The status shows "● Camera on" in red, then "Face found"                           |
| Turn your head left and right, nod, tilt                    | The avatar follows, the same way round (mirror on)                                 |
| Blink, open your mouth, smile                               | Eyes, mouth and smile follow                                                       |
| Calibrate, looking straight ahead                           | "Calibrated."; the avatar sits straight while you do                               |
| Cover the camera, then uncover it                           | "No face"; blinking goes automatic; tracking comes back                            |
| Deny the permission (in a fresh profile), then Start camera | A message saying where to allow it (site settings; on macOS, also System Settings) |
| Start camera while another app uses it (Windows)            | A message saying another app may be using it                                       |

**Note:** the tracking rate (Camera tab: "Tracking at N fps"), and any lag
you see between your head and the avatar.

## 3. Microphone

| Try                                                                          | Expect                                                  |
| ---------------------------------------------------------------------------- | ------------------------------------------------------- |
| General tab: pick your microphone, Start microphone                          | "● Microphone on" in red; the meter moves when you talk |
| Talk at your usual distance                                                  | The mouth opens with your voice and closes in silence   |
| "Whichever is wider" with the camera on; talk, then open your mouth silently | The mouth follows whichever is wider                    |
| Pick another microphone while it is on                                       | It switches without stopping                            |
| Minimize the window while talking                                            | Lip sync keeps going (needed for streaming)             |

**Note:** the sensitivity and gate you ended up with, and whether the mouth
moved in silence.

## 4. OBS with the browser

1. Start the bridge: `npm run bridge`. It prints a pairing code.
2. In Mochi Studio, follow the guide's last step (or the Camera tab): turn on
   output views through the bridge, enter the code, and copy the OBS
   address.
3. In OBS: Sources → + → Browser. Paste the address as the URL; width
   1920, height 1080. Leave "Shutdown source when not visible" off.

| Try                                                      | Expect                                                                                                       |
| -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| Add the source                                           | The avatar appears on a transparent background; the Camera tab lists the view ("ready (loaded … MB in … s)") |
| Move your head, talk                                     | The OBS view follows, with no visible lag behind the control window                                          |
| Set a chroma-key background; add OBS's Chroma Key filter | A clean key                                                                                                  |
| Load another model in Mochi Studio                       | The OBS view switches to it                                                                                  |
| Stop the bridge, then start it again                     | The view comes back by itself                                                                                |

**Note:** the view's load time (from the Camera tab), and the control
window's.

## 5. OBS with the desktop app

Get the packages from the "Desktop packages" workflow run (Actions →
artifacts). They are unsigned: [desktop.md](desktop.md) says how to open
them on each system.

| Try                                          | Expect                                                                                          |
| -------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| Start the app                                | Its window opens; no bridge to start, no pairing                                                |
| Open folder… (native dialog)                 | The model loads; the Camera tab shows the OBS address straight away                             |
| Add the address in OBS as in section 4       | The view loads; nothing is uploaded first (the Camera tab shows no "Preparing the model…" line) |
| Start the camera on macOS for the first time | macOS asks for camera access for Mochi Studio                                                   |
| Quit the app, then start it again            | The OBS view keeps its last frame, then follows the app again once it runs                      |

| Open a folder, quit, start the app again | The same model opens by itself; the Model tab lists it under Recent models |
| Rename that folder, start the app | A message that it is no longer there; the stage lists it as "moved or gone" |
| Add a hotkey Ctrl+Alt+F9 (or an F13–F24 key), focus a game or another app, press it | The avatar reacts; the Hotkeys tab said "works in other apps" |
| Add a hotkey another app has registered as a global shortcut (for example one set in Discord, or in OBS's own Hotkeys settings, with that app running) | The Hotkeys tab says the combination is taken; it still works in Mochi Studio's window |
| Add a hotkey on the plain key H | The Hotkeys tab says it stays window-only, and typing H in other apps is not affected |

**Note:** the view's load time, and anything the system warned about when
opening the app.

## 6. Windows and macOS

Repeat sections 1 to 5 on each system you have (browser: Chrome or Edge on
Windows, Chrome or Safari on macOS).

**Note:**

- whether file names with Chinese or Japanese characters load (folder and
  zip);
- on macOS: the camera and microphone prompts, and whether the app opens
  after the Gatekeeper steps;
- on Windows: the SmartScreen steps.

## 7. A machine with a graphics card

With a model loaded, the camera on and an OBS view open:

| Measure                                     | Where                                                                                                                        |
| ------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| The control window's frame rate             | Set the frame cap (Camera tab) to uncapped, then read the browser's FPS meter (DevTools → Rendering → Frame rendering stats) |
| The model's load time in the control window | From choosing the folder to the avatar showing                                                                               |
| The OBS view's load time                    | Camera tab: "ready (loaded … MB in … s)"                                                                                     |
| CPU and GPU use                             | Task Manager (Windows) or Activity Monitor (macOS), for the browser or app and for OBS                                       |

Also check:

- The Camera tab's tracking rate. It should be about 30 fps with a
  30 fps camera.
- Whether the frame rate drops while an OBS view loads. The control
  window drops to 2 fps on purpose for that time, and should come back
  right after.

**Note:** the numbers, the graphics card, and the screen's refresh rate.

## 8. Plugins made for VTube Studio

Switch on **Plugin server** in the settings' General tab (in the browser, with
`npm run bridge` running and paired). Use plugins you already have, for
example a stream tool with VTube Studio actions, a stream deck plugin, or
an audio-meter plugin that creates its own inputs.

| Try                                                                               | Expect                                                                                                                 |
| --------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| Connect the plugin to `ws://localhost:8001`                                       | Mochi Studio asks whether to allow it, with its name and icon                                                          |
| Allow it; trigger a hotkey and switch an expression from the plugin               | The avatar reacts; the status shows "● Plugin: …"                                                                      |
| Load another model or move the model from the plugin (desktop app: recent models) | It loads or moves                                                                                                      |
| A plugin that creates inputs: map one in the Model tab                            | Its values move the parameter                                                                                          |
| A plugin that reads values, with **May read tracking data** off, then on          | Defaults while off, real values while on                                                                               |
| Revoke it in the settings' General tab                                            | It stops working until allowed again                                                                                   |
| A tint action                                                                     | The tinted parts darken, in the window and in OBS; a white tint, or closing the plugin, restores them                  |
| A plugin that throws or drops items (images)                                      | It asks for the picture permission; with Allow, its pictures appear and move; Items marks them "for this session only" |
| A plugin that pins items to the model                                             | The item follows the part it is pinned to                                                                              |
| A plugin that asks you to choose art meshes                                       | A list on the left of the stage, with the plugin's text; OK and Cancel answer it                                       |
| A plugin that follows the model (outline or position)                             | It tracks the model as you drag it; with an outline, a dashed line follows the model                                   |
| A plugin that throws items at a tracked point (ArtMeshTrackingEvent)              | The items land where the point is, also while you move                                                                 |
| A plugin that sends an animated GIF                                               | It plays; the Items sheet shows its frame rate and Play/Pause                                                          |

**Note:** each plugin's name and version, which actions worked, which
failed (with the plugin's own error text, if it shows one), and whether it
found Mochi Studio by itself or needed the port.

## 9. The stage-first window (mouse, touch, items)

Use a mouse with a wheel and, if you have one, a touch screen. Have a PNG
with a transparent background at hand (a sticker, a hat).

| Try                                                                                 | Expect                                                                                                                         |
| ----------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| Double-click the empty stage; on a touch screen, double-tap                         | The main menu opens; Esc or a press on the stage closes it                                                                     |
| Main menu → Settings; switch tabs; close and open Settings again                    | Four tabs (General, Camera, Model, Hotkeys); it reopens on the last tab                                                        |
| Main menu → Change model                                                            | The model bar at the bottom: current model, recent ones (desktop app), Open folder… / Open zip…                                |
| Drag, scroll and Shift+drag the model                                               | It moves, zooms and turns                                                                                                      |
| Main menu → Lock model position, then drag and scroll                               | The model stays; tracking still moves it                                                                                       |
| Drop the PNG on the stage                                                           | It appears as an item, "Added … as an item"                                                                                    |
| Drag it onto the model's head; move your head                                       | It follows the head; the log (main menu → Log) names the art mesh it is pinned to                                              |
| Ctrl+click it (Command+click on macOS), and a model item (a hat)                    | Each flips, also in OBS; a pinned one stays pinned                                                                             |
| Double-click it, then try to drag it                                                | "Locked …"; it does not move. Double-click again unlocks it                                                                    |
| Drag it to the trash at the bottom right, and another one off the window            | Both are removed                                                                                                               |
| A hotkey on the middle mouse button, and one on Back (a side button)                | Each fires while the window has focus; in the desktop app, not in other apps (by design)                                       |
| Ten hotkeys with Button ticked                                                      | Eight buttons down the right side                                                                                              |
| A model folder with a missing texture                                               | A short message that points to the log; the log says which file is missing                                                     |
| Model tab: a rule while the idle animation plays, and with an expression            | The line under each rule names what drives the parameter                                                                       |
| An idle animation that moves the head; turn your head, then leave the camera's view | Your head turns win while you are in view; out of view the idle animation takes over, without a jump, in the window and in OBS |

**Note:** anything a double-click or a double-tap did that you did not
expect (on an item, on a button, on the model), and whether the mouse
buttons Back and Forward reach Mochi Studio on your system.

## 10. Animated items

Have an animated GIF at hand (a sticker, 20 to 100 frames), and a folder of
PNG frames exported from an animation tool.

| Try                                                                     | Expect                                                              |
| ----------------------------------------------------------------------- | ------------------------------------------------------------------- |
| Drop the GIF on the stage                                               | An item that plays at the GIF's own speed, in the window and in OBS |
| Items: Frame rate 30, then 0; Pause and Play                            | It speeds up, holds its frame at 0, pauses and plays again          |
| Add the PNG folder with Add item folder… (or drop it on the stage)      | An item that plays its frames in name order (frame2 before frame10) |
| Pin the item to the model, then turn your head                          | It plays and follows the model                                      |
| A GIF of hundreds of large frames                                       | It plays, at a lower resolution if it had to be scaled to fit       |
| Camera tab: Handover 2000 ms, then leave and re-enter the camera's view | The idle animation fades in and out over two seconds                |

**Note:** how long a large GIF takes to become an item, and anything that
plays at the wrong speed or in the wrong order.

## 11. Physics, expressions and item scenes

The automated tests have no physics file of their own (they give the
runtime two physics groups by hand), so the physics checks need a real
model with physics, such as DeepSeek-chan.

| Try                                                                                       | Expect                                                                                          |
| ----------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| Model tab: Strength 0, then 100, and shake your head                                      | At 0 the hair holds still, as with physics off; at 100 it swings about twice as far             |
| Wind 50, then 100                                                                         | The hair and clothes blow in gusts that drift from side to side, in the window and in OBS alike |
| Physics groups: one group at ×0, another at ×2                                            | Only that group holds still, or swings more; the names match the model's physics file           |
| A plugin that changes physics (or wind) for a few seconds                                 | The Model tab says which plugin; your settings come back when it stops                          |
| Hotkeys tab: New expression, tick a few parameters in each mode, Show it on the model     | The model shows it at once; Add and Multiply combine with tracking                              |
| Tick a parameter that physics drives (a hair parameter)                                   | A warning that physics overwrites it                                                            |
| Save in the desktop app; look in the model folder                                         | A new `.exp3.json` file there; it loads again with the model                                    |
| Save in a browser, then Export                                                            | A download of the `.exp3.json` file; the expression is still there after reloading the page     |
| Create hotkeys for expressions without one                                                | One hotkey per expression, without keys; give them keys and try them                            |
| Items: place three items, make two scenes in one group, and a hotkey with a 1-second fade | Turning one scene on turns the other off; the items fade in and out, also in OBS                |
| A scene hotkey "On for some seconds", 10 seconds                                          | The scene goes off by itself after ten seconds                                                  |
| A GIF whose frames have different delays (a sticker that pauses on one frame)             | It plays with the pauses; doubling its frame rate in the Items sheet plays it twice as fast     |

**Note:** whether the wind looks like wind (too strong or weak at 100?), and
an expression that looks different in OBS than in the window.

## 12. The advanced lipsync (vowels)

A model with `ParamA` … `ParamO` helps, and one with a motion-sync file
(`.motionsync3.json`) if you have one. The automated tests use synthetic
vowels and give the runtime a motion-sync setting by hand, since no such
file is among the test models.

| Try                                                                   | Expect                                                                                   |
| --------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| General tab: Lipsync type Advanced, Start microphone                  | The vowel meter shows silence; the log or a notice says which vowel parameters it mapped |
| Say "a, i, u, e, o" slowly                                            | The meter's bar moves from vowel to vowel; with ParamA … ParamO the mouth shapes follow  |
| Talk normally, then whisper                                           | Vowels while you talk; mostly silence while you whisper                                  |
| Your voice: New voice, record A, I, U, E, O and Silence               | Each button gets a ✓; the vowels read more surely afterwards                             |
| Reload the page                                                       | The voice is still chosen, with its ✓ marks                                              |
| A noisy room (music in the background): voice processing off, then on | With it on, fewer vowels are heard in the noise                                          |
| A model with a motion-sync file: Mouth shapes → the model's setting   | The model's own mouth shapes; OBS shows the same mouth                                   |
| A plugin that reads `VoiceA` (with and without tracking data allowed) | Real values only when allowed                                                            |

**Note:** vowels it mixes up (with and without your voice calibrated), and
how late the mouth is.

## 13. Hands, gestures and the basic mouth

Run `npm run fetch:models` first (it fetches the hand model too). The
automated tests feed synthetic hand points as a tracker would; only real
hands show how well MediaPipe sees them and how sure the gestures are.

| Try                                                                          | Expect                                                                                    |
| ---------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| Camera tab: The camera tracks → Hands only, Start camera                     | The camera starts; no "Face found", and no error                                          |
| Tick Show the hands here; hold up one hand, then both                        | Points and bones only (no picture); each hand's readout and "not seen" for a missing hand |
| Curl and straighten each finger in turn                                      | That finger's value goes from about 0 to about 1; "open" follows                          |
| Make each gesture: open hand, fist, point, peace sign, thumbs up             | Its chip shows; nothing for a half-bent hand or a thumb held sideways                     |
| Mirror on: raise your right hand                                             | The readout says "Your right hand"; the mapping's `HandLeft…` inputs move (mirrored)      |
| Face and hands: move your head and hands together                            | Both drive the avatar; note the tracking rate (it runs two models)                        |
| A hotkey with a fist gesture on one hand, hold 0.5 s, "On while held"        | On after about half a second, off when you open the hand                                  |
| The same with Either hand (mirrored), then with the other hand               | It fires with either hand                                                                 |
| A Hands together pose                                                        | Fires when the palms meet; not with the hands apart                                       |
| A model without `ParamA` … `ParamO`: Lipsync type Advanced, Start microphone | A notice that the vowels shape the mouth form; saying "i" widens the mouth, "o" rounds it |
| Untick Vowels shape the mouth                                                | The mouth form follows the camera's smile only                                            |

**Note:** how sure each gesture is (does it flicker, or come from other
hand shapes?), the finger values of a relaxed open hand and of a loose
fist, the tracking rate with hands only and with face and hands, and
whether the mouth-form values (I and E widen, U and O round) look right on
your model.

## 14. A phone as the face tracker

An iPhone (Safari) and an Android phone (Chrome) help, on the same Wi-Fi as
the computer. The automated tests run the phone page in desktop Chromium
on 127.0.0.1, with a fake camera, so the network, the certificate warnings
and real phones are untested.

| Try                                                                     | Expect                                                                                          |
| ----------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| Camera tab: tick Phone tracker                                          | The address, a QR code and a six-digit code; the firewall may ask once (allow private networks) |
| Scan the QR code with the phone                                         | The browser warns about the certificate; after continuing, the phone page                       |
| Type the code, press Connect to PC, allow the camera                    | "Connected to Mochi Studio" and a frame rate; the Camera tab lists the phone as connected       |
| Turn your head, blink, open your mouth, with this computer's camera off | The avatar follows; Calibrate works                                                             |
| This computer's camera on too, then cover it                            | The webcam wins while it sees you (the default); covered, the phone takes over                  |
| Switch "When both see your face" to the phone                           | The phone wins while it sees you; cover the phone's camera and the webcam takes over            |
| Turn Wi-Fi off on the phone for ten seconds, then on                    | The page says it reconnects, and does                                                           |
| Reload the phone page                                                   | It connects by itself (no code)                                                                 |
| Revoke the phone in the Camera tab                                      | The phone says it was revoked and asks for a new code                                           |
| Untick Phone tracker; open the address on the phone again               | It does not load (the port is closed)                                                           |

**Note:** the phone model and browser, the frame rate, the lag you see,
how the certificate warning looked (and whether Safari let you continue),
and whether the screen stayed on.

## 15. Items between layers, and the new gestures

| Try                                                                        | Expect                                                                        |
| -------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| A plugin that sorts items: put a hat just in front of a hair art mesh      | The hat between the hair layers; the same in OBS; after a reload, still there |
| The same plugin splitting a scarf item, back part behind the neck          | The scarf around the neck                                                     |
| Items sheet: Draw it whole                                                 | The item in front of the whole model again                                    |
| Hands: an OK sign, then a pinch (other fingers curled)                     | The hand preview shows each; a hotkey on one fires                            |
| Camera tab: Gesture sensitivity for a gesture that is hard to hold, raised | It is recognized more easily; lowered, less                                   |

**Note:** gestures that are mixed up (a pinch read as an OK sign, a fist
read as a pinch), and the sensitivity values that suit your hands.

## 16. Out of sight, the mouse, a controller and the voice frequency

The automated tests stop the control window's animation frames the way a
hidden window does, move the pointer over the page, and stand a script in
for the browser's controller list. A real minimized window, the pointer
outside the page, real controllers and a real voice are untested.

| Try                                                                        | Expect                                                                                                               |
| -------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| OBS showing the output view; minimize the control window, or cover it      | The avatar in OBS keeps moving with your face and voice                                                              |
| The same in the desktop app                                                | The same                                                                                                             |
| The same, watching the GPU use (Task Manager, or `nvidia-smi`)             | Mochi Studio's share drops while the control window is minimized; restored, the stage shows the current pose at once |
| A rule from `MousePositionX` to the head turn; move the mouse (browser)    | The head follows while the pointer is over the page                                                                  |
| The same in the desktop app, the pointer over another app                  | The head follows anywhere on the main screen                                                                         |
| Camera tab: Pointer range X 400                                            | The head turns fully 200 px either side of the middle                                                                |
| Connect a controller, press a button; Camera tab                           | "One controller connected", and its name in the list                                                                 |
| Rules from the sticks and triggers; move them                              | The live inputs follow; the left stick up reads `ControllerStickLeftY` 1                                             |
| A hotkey: click its key, press Cross (A) on the controller                 | The key reads "Controller Cross (A)"; pressing it fires the hotkey                                                   |
| The same with the browser in the background (and in the desktop app)       | Note whether the controller still works                                                                              |
| A DualShock 4 or DualSense: touch the pad, turn the controller             | Note whether the touchpad and orientation inputs appear (most browsers give neither)                                 |
| Advanced lipsync, a rule from `VoiceFrequency` to the mouth form; say i, o | The mouth widens on i and rounds on o; at rest it is in the middle                                                   |
| Import a VTube Studio file whose hotkeys have gestures                     | The import lists the gesture as kept but not used; the Hotkeys tab shows it under Gesture                            |
| Model tab: Rate, 120 steps a second, then Same as the app                  | The hair swings a little more smoothly at 120                                                                        |

**Note:** the browser and controller (and which buttons it has), whether
the controller works with the window in the background, the pointer on a
second screen in the desktop app, and the weights that suit your model's
mouth shape.

## 17. Item scenes from the menu, Alt+click hotkeys and screens

| Try                                                                      | Expect                                                                  |
| ------------------------------------------------------------------------ | ----------------------------------------------------------------------- |
| Main menu: Item scenes                                                   | The Items sheet, at its scenes                                          |
| Two scenes in one group; turn each on with OBS showing the output view   | One at a time, in the window and in OBS                                 |
| A hotkey on Alt+click (or Ctrl+click on a Mac); click the stage with Alt | It fires; a plain click and an Alt-drag of the model do not             |
| Desktop app with two screens: Camera tab, Screen, the second one         | The mouse inputs centre on that screen; on the main screen they stay ±1 |

**Note:** whether Alt+click conflicts with anything on your system (some
Linux desktops move windows on Alt+drag).

## 18. Light from the screen

The automated tests feed a made-up picture (red, green and blue thirds) in
place of the browser's capture, and capture a virtual screen in the desktop
app. Real screens, windows and games are untested.

| Try                                                                   | Expect                                                                        |
| --------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| Camera tab: Light from the screen, Start; share a screen with a video | The two squares follow the video's colors; the model darkens with dark scenes |
| Untick Middle while a game shows a bright sky in the middle           | The light follows the sides only                                              |
| Smoothing 60                                                          | The light changes over about two seconds                                      |
| Items too                                                             | Items darken with the model                                                   |
| OBS showing the output view                                           | The same light in OBS                                                         |
| Stop sharing from the browser's own bar                               | The light stops, and the model has its own colors again                       |
| Desktop app: choose a window under Capture, Start                     | The light follows that window                                                 |

**Note:** the system (some ask for a screen-recording permission, macOS in
particular), whether the light looks right, and the settings you like.

## 19. The light's details and web items

The automated tests use a static color, made-up strengths and a local test
page with a red background. Real chats, alert boxes and games are untested.

| Try                                                                   | Expect                                                  |
| --------------------------------------------------------------------- | ------------------------------------------------------- |
| Light from the screen: a dark blue static color, Use the static color | The model turns blue-dark; Reset goes back to 15, 40, 3 |
| Model tab: strength 0 for the eyes, with a dark light                 | The eyes keep their colors                              |
| Import VTube Studio settings with Screen Overlay hotkeys; press one   | The light's values change to the hotkey's               |
| Desktop app: Items, Web item, a stream chat's popout address          | The chat shows as an item and scrolls with new messages |
| The same with OBS showing the output view                             | The chat in OBS too, a little behind                    |
| A page with sound or a video                                          | Nothing is heard                                        |
| A web item at 1920 × 1080, 30 frames per second, on a slower computer | Note how much it costs (the item and the views)         |
| The browser: Items                                                    | A note saying web items need the desktop app            |

**Note:** whether your chat or alert service shows in a window with no
cookies (some need a sign-in), and whether the frame rate is enough.

## 20. Streaming for hours

The automated tests run an hour of stream events in 90 seconds
(`test/browser/soak.test.ts`). `npm run soak -- --heavy` runs three hours of
events in 20 minutes on a model of DeepSeek-chan's size, `npm run
frame-budget` measures frame times, and `npm run startup` measures startup.
None of them has a graphics card or a real camera.

| Try                                                                       | Expect                                                          |
| ------------------------------------------------------------------------- | --------------------------------------------------------------- |
| A real stream of two hours or more, with OBS, the camera and your plugins | No slowdown; the Log has nothing you did not expect             |
| The task manager at the start and the end                                 | Mochi Studio's memory about the same                            |
| `npm run frame-budget` on a computer with a graphics card                 | Note the frames a second and the times per frame                |
| The desktop app with your largest model as the last one: start it         | Note how long until the model is on screen                      |
| Log → Save for a bug report…                                              | A text file with the log; no names, addresses or pictures in it |

**Note:** the frame budget and startup numbers on your computer, with
DeepSeek-chan and your own models.

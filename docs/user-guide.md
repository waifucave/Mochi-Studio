# Mochi Studio user guide

## The window

The stage fills the window; the controls float over it.

- **The main menu**: double-click (or double-tap) the stage anywhere outside
  an item, or use the **☰** button at the top left. It has **Change model**,
  **Screenshot**, **Background**, **Items**, **Lock model position**,
  **Lock items**, **Settings** and **Log**. Esc closes it, and any open
  sheet.
- **Change model** opens the model bar at the bottom: the current model,
  recent ones (in the desktop app), **Open folder…** and **Open zip…**.
- **Settings** opens a sheet on the right with four tabs:
  1. **General**: voice lipsync (the microphone), the bridge, agents and
     plugins;
  2. **Camera**: camera and tracking, calibration, smoothing, the frame
     rate, the background (transparency included) and output views;
  3. **Model**: the model's name and files, its idle animation, the
     settings import, movement and the mapping (with **Auto-Setup**);
  4. **Hotkeys**: hotkeys and expressions.

  Settings reopens on the tab you used last.

- **Log** lists recent messages, newest first: every notice that popped up,
  load reports, and errors. When a model will not load, the reason is here.
  A message that repeats is shown once with a count. **Copy** copies the
  log; **Save for a bug report…** saves it as a text file with the app's
  version and a few counts. Names, e-mail and network addresses, home
  folders, long keys and the query part of addresses are left out of every
  message, and no camera picture ever goes in
  ([Streaming for hours](#streaming-for-hours)).
- On-screen hotkey buttons run down the right side of the stage.
- Status chips (camera, microphone, agents, output views, plugins), the
  **Guide** button, and undo and redo sit at the top right.

### Getting started

On first use, the **Getting started** card at the top of the stage walks
through four steps: load a model, start the camera, calibrate, and show the
avatar in OBS. Each step has its button, and says what went wrong if it
fails (a blocked camera, a folder that is not a model). The card goes when
you hide it; the **Guide** button brings it back. The empty stage also says
that a double-click opens the main menu.

### Mouse on the stage

| On the stage                                 | Does                                                            |
| -------------------------------------------- | --------------------------------------------------------------- |
| Drag the model                               | Moves it                                                        |
| Scroll wheel                                 | Zooms                                                           |
| Shift+drag                                   | Turns the model                                                 |
| Double-click empty stage                     | Opens the main menu                                             |
| Drag an item                                 | Moves it; dropped on the model, it is pinned there              |
| Double-click an item                         | Locks it (a locked item cannot be dragged), or unlocks it       |
| Ctrl+click an item (Command+click on macOS)  | Flips it (mirrored left to right)                               |
| Drag an item to the trash, or off the window | Removes it (the trash shows at the bottom right while you drag) |
| Drop image files on the stage                | Each becomes an item                                            |

**Lock model position** in the main menu stops dragging, zooming and
turning the model (tracking still moves it). **Lock items** locks all items
at once.

## Loading a model

A model is a folder that holds a `.model3.json` file and the files it refers
to (`.moc3`, textures, physics, expressions, motions).

Open models from the main menu's **Change model**, or in the Model tab of
the settings:

- **Open folder…** picks the folder. In the desktop app it opens the
  system's folder dialog, and OBS views then read the files straight from
  disk, so nothing has to be copied to them first.
- **Open zip…** picks a zip of the folder.
- **Load URL** takes the address of a `.model3.json` or a `.zip`. With a
  `.model3.json` address, only the files the manifest lists are available.
- You can also drop a folder or a zip on the stage.
- **Try the sample model**, on the empty stage and in the guide's first
  step, loads «Mochi», a small model that comes with Mochi Studio: its head
  tilts, it blinks, its mouth follows the voice, its front hair swings, and
  it has a short idle motion. It is also at the address
  `samples/mochi/mochi.model3.json` beside the app's pages.

If a model will not load, a notice says why in short and points to the log
(main menu → **Log**), which has the full reason and the files that are
missing.

Mochi Studio draws models with WebGL 2. If the browser or the computer does
not offer it, the stage shows a message saying so, with what to try: turn on
hardware acceleration in the browser's settings, update the graphics
drivers, or try another browser (for OBS, make sure Browser Source hardware
acceleration is on). The settings keep working, but models cannot be shown.

Zips are read by Mochi2D, which also understands file names written in older
encodings (Chinese, Japanese, Korean). RAR and 7z archives are not supported:
extract them first.

When a manifest lists no expressions or motions, Mochi Studio offers the
`.exp3.json` and `.motion3.json` files it finds in the folder (marked "found
in folder").

Settings are saved per model in this browser. The same model loaded from a
folder or a zip shares its settings. **Export…** saves them as a JSON file;
**Import…** loads such a file into the current model. Tick **Include item
files** to export a zip with the items' folders as well; items are models
with their own terms of use, so check those before sharing the file.
**Import…** takes both the JSON file and the zip.

**Name** (at the top of the Model tab) gives the model a name of your own.
It shows in the model bar, the recent list (desktop app) and to plugins;
left empty, the folder or zip name is used.

**Idle animation** picks an animation (a `.motion3.json` motion) that loops
while nothing else plays. It moves only what tracking does not: while a
face is tracked (or a plugin sends a value), the parameters your mapping
drives follow you, and when the face is lost the idle animation takes them
over again. Both handovers fade over about half a second.

**Physics** (for models with a physics file) is the swinging of hair,
clothes and accessories:

- the switch turns it on or off;
- **Strength**, 0 to 100: 50 is the model as it was made, 0 holds
  everything still, 100 doubles the swing;
- **Wind**, 0 to 100: gusts of wind whose direction drifts slowly from one
  side to the other (0 is none);
- **Physics groups**: a multiplier from 0 to 2 for each group of the
  model's physics (named as in its physics file), times the strength;
- **Rate**: how often the physics is worked out. **The model's own** (the
  default) is the rate in its physics file; **Same as the app** is once a
  frame; or 30, 60 or 120 steps a second. Higher rates swing more smoothly
  and cost a little more time each frame;
- **Reset physics** goes back to 50, no wind, every group at ×1 and the
  model's own rate.

They are saved with the model. A plugin can change them for a few seconds
at a time; the Model tab then says which one, and your settings come back
when it stops.

### Importing settings from VTube Studio

Many models come with a VTube Studio settings file (`<name>.vtube.json`).
In the settings' **Model** tab, **Import <file>** reads the one in the model's folder
(or choose one with **Choose a .vtube.json file…**). Before anything
changes, Mochi Studio lists:

- what it imports: tracking mappings (input, ranges, clamping, smoothing),
  hotkeys for expressions, animations (including "hold the last frame"),
  "all expressions off" and calibration, with their keys, the idle animation
  and the physics switch;
- what it skips, and why (for example inputs Mochi Studio does not have,
  such as `TongueOut`, or a plugin's own inputs);
- what it assumed, where the file's meaning is not known (marked
  "Assumed"). Everything imported can be changed afterwards in the Model
  and Hotkeys tabs;
- fields it does not know, which are ignored.

Mappings on any documented input are kept as they are: the
face, voice, hand, mouse and controller inputs, and mocopi's, which have no
value in Mochi Studio (the list says so). A hotkey's hand-gesture settings
are kept with the hotkey exactly as the file has them, and saved and
exported with it unchanged, but they do nothing: the names the file uses
for gestures are not known yet. The Hotkeys tab shows them; set up a
gesture of Mochi Studio's own instead ([Gestures](#gestures)). Keys are read
by the file's key names; its mouse buttons become Mochi Studio's.
A left button with a modifier becomes a left-click hotkey; a plain left
button, which stays for clicking here, leaves the hotkey with its on-screen
button only.

**Apply** replaces the model's mappings and hotkeys with the imported ones.
The import never changes the `.vtube.json` file.

## Face tracking

Open the settings' **Camera** tab and choose **Start camera**. The status
at the top right shows "● Camera on" in red for as long as the camera is on.
Tracking runs entirely on this computer: the camera picture is never sent,
saved, or shown in outputs, screenshots or recordings; only the movements it
measures drive the avatar. The camera picture is not shown at all unless you
tick **Show the camera picture here**, which shows it in that tab only.

- **Mirror** (on by default) makes the avatar move like your mirror image.
- **Calibrate**: look straight at the camera with a relaxed face
  and hold still during the countdown. Mochi Studio averages your pose for
  1.5 seconds and treats it as the centre from then on.

### Smoothing

Tracking values pass through a **One Euro filter** (Casiez, Roussel and Vogel,
2012). It is a low-pass filter whose cutoff frequency rises with the speed of
the signal: when you hold still it smooths strongly and removes jitter; when
you move quickly it lets the movement through with little delay.

- **Minimum cutoff** (Hz, default 1.5): lower is steadier but laggier when
  still.
- **Speed coefficient** (default 0.02): higher reduces lag on fast moves but
  lets more jitter through.

Each mapping rule also has its own **smoothing** slider, independent of the
frame rate, and a choice of how it works:

- **Gradual** (the default for most inputs): an exponential smoothing with
  a time constant of up to 500 ms.
- **Rate limit** (the default for the voice inputs: the vowels, silence,
  volume, frequency and those made from them): the value may only travel
  so fast, a full swing of the rule's output range taking up to 250 ms
  going up and 500 ms coming down. Small changes pass at once, so the mouth
  keeps up with speech, opens quickly and closes a little more slowly.

**Handover to and from the idle animation** (ms, default 500, up to 5000):
how long the parameters your mapping drives take to pass from the idle
animation to tracking when a face is found, and back when it is lost. 0
switches at once.

### Hand tracking

**The camera tracks** (Camera tab) chooses **Face only** (the default),
**Hands only** or **Face and hands**. The hands are tracked like the face,
in the page, by MediaPipe's hand landmarker: up to two hands, 21 points
each. Its model file comes with the face's (`npm run fetch:models`).
Fast hand movements can lose a hand for a moment, and tracking face and
hands together takes more of the computer than either alone. Without a
graphics card MediaPipe runs on the processor, where a frame of hand
tracking can take most of a second on a slow computer; tracking then gets
at most half the time, so drawing and plugins keep going, and fewer frames
a second are tracked.

**Show the hands here** (off by default; there while hands are tracked)
draws the points the tracker finds, never the camera picture, with how
straight each finger is, how open each hand is, the distance between the
hands and the gestures seen. It is in the Camera tab only, never in
outputs, screenshots or recordings.

The hands give these inputs, for the mapping and for plugins you allow to
read tracking data, under the documented names of the plugin API:

| Input                                                                           | Range     | What                                                                                                                                       |
| ------------------------------------------------------------------------------- | --------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `HandLeftFound`, `HandRightFound`, `BothHandsFound`                             | 0 or 1    | whether each hand is seen, and both                                                                                                        |
| `HandLeftPositionX`, `…Y`, `…Z` (and `HandRight…`)                              | −10 to 10 | the palm's place in the picture: X away from the middle (positive outwards, for both hands), Y up, Z its nearness (0 at a usual distance)  |
| `HandLeftAngleX`, `HandLeftAngleZ` (and right)                                  | ±180°     | the hand's left/right turn (X: 0 with the palm towards the camera) and its lean (Z: 0 with the fingers up)                                 |
| `HandLeftOpen`, `HandLeftFinger_1_Thumb` … `HandLeftFinger_5_Pinky` (and right) | 0 to 1    | how open the hand is (the fingers' mean), and each finger: 0 curled, 1 straight                                                            |
| `HandDistance`                                                                  | 0 to 20   | the distance between the palms, in the positions' units, while both hands are seen (Mochi Studio's scale: the documented one is not known) |

Left and right are your own hands. With **Mirror** on they swap, like the
head, and the angles turn around, so the avatar moves like your mirror
image; X stays as it is, since outwards is outwards in a mirror too. The
angles' signs are Mochi Studio's own (both positive towards your left),
since the documentation gives none. While a hand is not seen its found input
is 0 and its other inputs have no value, so rules on them leave their
parameters to the idle animation, as without a face. Find the inputs in the
mapping editor's list under "Hand:". Mappings saved with earlier names
(`HandLeftFingerThumb`) move to these when they are loaded.

### A phone as the face tracker

A phone on the same network can track your face instead of this
computer's camera. The phone's browser runs the tracking (MediaPipe, as
here) and sends only the movements: the blendshapes and the head's pose.
Its camera picture never leaves the phone, and the phone page does not
show it.

1. In the Camera tab, tick **Phone tracker (on the local network)**. (In a
   browser, the bridge does this: start it with `npm run bridge`, and type
   its pairing code once. The desktop app has it built in.)
2. Put the phone on the same Wi-Fi as this computer.
3. Scan the QR code with the phone's camera, or type the address shown
   (`https://192.168.…:27890/`) in its browser.
4. The browser warns that the connection is not private. That is
   expected: the certificate is Mochi Studio's own, made on this computer,
   and nobody else vouches for it. Continue (Chrome: **Advanced**, then
   **Proceed**; Safari: **Show Details**, then **visit this website**). The
   Camera tab shows the beginning of the certificate's fingerprint, which
   the browser can show too.
5. Type the pairing code shown in the Camera tab and press **Connect to
   PC**. Allow the camera when the browser asks.

The phone then shows "Connected to Mochi Studio" and how many frames a
second it sends; keep the page open and the screen on (the page asks the
browser to keep it on). An approved phone connects again by itself, also
after the page is reloaded or the network drops for a while. Each pairing
code pairs one phone; after five wrong codes the code changes.

**Approved phones** are listed in the Camera tab: **Revoke** disconnects
one, and it needs a new code to come back.

**Phone and webcam together.** **When both see your face, use** chooses
which one wins while the phone and this computer's camera both see your
face: this computer's camera by default. When the one chosen loses your
face, the other takes over, and gives it back when the first sees you
again. Hands
always come from this computer's camera, so a phone for the face and
**Hands only** here work together. **Calibrate** works with only the phone.

**What is on the network.** While the phone tracker is on, this computer
listens on one port (27890, or the next free one) on its network
addresses, over https. Reachable there: the phone page, its scripts and
MediaPipe's face-tracking files (all public code), and the tracking
connection, which takes a pairing code or an approved phone's token and
then only face values. Nothing else is: no other page, no file, no
command. Untick **Phone tracker** to close the port; it is off until you
turn it on, and stays as you left it. The first time, the computer's
firewall may ask whether to allow incoming connections: allow them on
private networks only.

### Light from the screen

The Camera tab's **Light from the screen** lights the model with the colors
of a screen or a window, as a game or a video would light you.

1. Press **Start**. A browser asks which screen, window or tab to share;
   the desktop app lists them under **Capture** (↻ lists them again).
2. The picture is cut into three upright thirds, **Left**, **Middle** and
   **Right**; the light is the average of the thirds that are ticked.
3. **Base brightness** (0 to 100) adds light whatever the screen shows,
   **Color boost** (0 to 100; 50 takes the colors as they are) scales the
   screen's colors, and **Smoothing** (0 to 60) makes the light follow
   slowly (60: about two seconds). The color on the model is the average
   times boost / 50, plus 255 times base / 100 (as plugins expect).
4. **Items too** lights the items as well.

**The defaults** follow the documented ones:
base brightness 15, color boost 40, smoothing 3, every part on, items too.
**Reset** goes back to them.

**A static color** instead of a capture: pick it under **Static color**,
then **Use the static color**. The same formula applies, with the color in
place of the screen's average.

**Strength per art mesh.** In the Model tab, **Light strength per art mesh**
sets how much of the light an art mesh takes, from 0 (none: it keeps its
own colors, for eyes that glow in the dark) to 1 (all of it, the default).
At strength s a mesh is multiplied by 1 + s × (light − 1). The strengths are
saved with the model, and imported from VTube Studio settings.

**Screen overlay hotkeys** (Hotkeys tab, **Screen overlay (the light)**):
**Record settings** takes the light as it is now: off, or on with the
static color or a capture, and the panel's values. Pressing the hotkey
applies them. A capture itself can only be started from the Camera tab (a
browser asks which screen), so a capture hotkey applies its values to the
capture that is running. Imported VTube Studio Screen Overlay hotkeys
become these, with their file's settings kept as they were.

The two squares show the screen's average and the light. Output views show
the light too; plugins read it (`SceneColorOverlayInfoRequest`).

**Brighter and darker.** The light multiplies the model's colors by up to
1.8 (never past white), as the formula allows, and darkens them down to
black.

**Privacy.** Nothing is captured until you press **Start**, and the capture
stops with **Stop**, or when you stop sharing in the browser. The picture
stays in this window: Mochi Studio shrinks it to 48 × 27 pixels about ten
times a second and keeps only the three average colors. No picture is
kept, shown or sent anywhere, the bridge, output views and plugins
included; they get the colors only.

### Mouse and controller

The Camera tab's **Mouse and controller** section sets up two more kinds of
input for the mapping. Both settings are for every model.

**The mouse.** `MousePositionX` and `MousePositionY` are the pointer's
place, from −1 to 1:

- around the middle of the page in a browser (the pointer counts only over
  the page), and of a screen in the desktop app, which follows it anywhere
  on the screen: the main screen, or the one chosen under **Screen**;
- across **Pointer range X** and **Y**, in pixels; 0, the default, is the
  whole page or screen;
- X positive to the right and Y positive upwards; beyond the range they stay
  at −1 or 1.

These are Mochi Studio's own choices: the documentation does not say where
the ranges are centred or which way Y goes.

**The controller.** A game controller's sticks, buttons and triggers are
the 39 `Controller…` inputs, read through the browser. **Controller**
chooses **No controller**, **All controllers** (the default: a button counts
while any controller holds it, and a stick or trigger is the one pushed
furthest) or one controller by name. A browser shows a controller only
once one of its buttons has been pressed.

| Inputs                                                                                               | Range          | What                                                                                    |
| ---------------------------------------------------------------------------------------------------- | -------------- | --------------------------------------------------------------------------------------- |
| `ControllerStickLeftX`, `…LeftY`, `…RightX`, `…RightY`                                               | −1 to 1        | the sticks, Y up, with a small dead zone in the middle                                  |
| `ControllerDPadX`, `ControllerDPadY`                                                                 | −1, 0 or 1     | the D-pad, right and up positive                                                        |
| `ControllerCross`, `…Circle`, `…Square`, `…Triangle`, `…ShoulderLeft/Right`, `…StickPressLeft/Right` | 0 or 1         | the buttons (Cross is A on other controllers, Circle B, Square X, Triangle Y)           |
| `ControllerOptionLeft`, `…OptionRight`, `ControllerHome`                                             | 0 or 1         | Select or Share, Start or Options, and the home button                                  |
| `ControllerTriggerLeft`, `…Right`                                                                    | 0 to 1         | the triggers, as far as they are pulled                                                 |
| `ControllerButtonsAnyLeft/Right`, `ControllerButtonCountLeft/Right`                                  | 0 or 1; 0 to 8 | whether any button of a side is held, and how many                                      |
| `ControllerLean`                                                                                     | −1 to 1        | a lean towards the side being pressed, and with the sticks                              |
| `ControllerThumbPosLeft/Right`                                                                       | 0 to 3         | where each thumb probably is: 0 the buttons, 1 the stick, 2 an option button, 3 the pad |
| `ControllerFingerPosLeft/Right`                                                                      | 0 to 2         | where each index finger probably is: 0 the shoulder button, 1 the trigger, 2 both       |
| `ControllerTouchPad…`, `ControllerOrientationX/Y/Z`                                                  | 0 to 1; ±60°   | the touchpad and the controller's turn and tilt, only where the browser gives them      |

The last five rows are Mochi Studio's own definitions, as the documentation
gives none:

- **The sides:** the left side is the D-pad, L1, L2, L3 and the left
  option button; the right side is the four face buttons, R1, R2, R3 and
  the right option button. A trigger counts as held past half-way; home and
  the touchpad belong to neither.
- **Lean:** half-way towards the side whose buttons are held (none, or
  both: no lean), plus a quarter of the two sticks' sideways push.
- **Thumbs and fingers:** where each was last seen, by what it holds or
  touches. Before anything is pressed, the left thumb is on its stick and
  the right one on the buttons.

The touchpad's inputs (positions from 0 at the left and bottom to 1 at the
right and top) and the orientation (in degrees from the way the controller
pointed when it was first seen; **Reset orientation** makes the way it
points now straight ahead) need a browser that gives them; most do not, and
then these inputs have no value. A controller's buttons and stick
directions can also be a hotkey's keys ([Hotkeys](#hotkeys-and-buttons)).

**mocopi.** The mocopi body-tracking inputs (`MocopiAngleX`,
`MocopiUpperArmLeftAngleY` and so on, 29 in all) are in the mapping
editor's list with their usual ranges, so imported mappings keep them, but
Mochi Studio cannot receive mocopi data yet: they have no value, and rules
on them do nothing.

## Mapping

The settings' **Model** tab lists the mapping rules. Each rule takes one
tracking input to one model parameter:

- **in** min/max: the input range that maps to the output range;
- **out** min/max: the parameter values at the ends of the input range;
- **Invert** flips the result within the output range;
- **Limit Range** keeps the result inside the output range;
- **Smoothing**: see above.

Rules that target the same parameter add up. The live bar shows the current
output. **Auto-Setup** replaces the rules with ones from the tracking inputs
to the standard parameter IDs that the model has.

**What drives it.** Under each rule, a line says what decides the
parameter's value right now, for when the model does not move. From lowest
to highest, Mochi Studio's order is:

1. the **idle animation**, while tracking has no value for the parameter;
2. **tracking** (or a **plugin** that sets the tracking input): the rule
   sets the parameter's value, and the idle animation stays off it;
3. an **animation** a hotkey plays: it overrides tracking while it plays;
4. an **expression** that sets the parameter overrides that; expressions
   that add to or multiply a parameter adjust the value instead;
5. **physics** overrides everything for the parameters it drives.

For example "Driven by the idle animation idle.motion3.json; tracking takes
over when a face is found" means no face is tracked now. While the line
says "handing over", one source is fading into the other.

Inputs: head yaw, pitch and roll (degrees), head position, eye openness, eye
smile, gaze, brows, cheek puff, mouth open, mouth smile/frown, every raw
blendshape (`bs.jawOpen`, `bs.mouthPucker`, …), the voice inputs (advanced
lipsync), the hand inputs ([Hand tracking](#hand-tracking)), the mouse and
controller inputs, and mocopi's ([Mouse and controller](#mouse-and-controller)).
Choosing an input gives the rule its usual range as the input range.

**Parameters driven by physics.** On some models, physics sets a parameter
every frame from another one: DeepSeek-chan's head angle `ParamAngleX`
follows its own `AngleX`, for example. A rule on such a parameter would have
no effect, so Mochi Studio writes the driving parameter instead, scaled
between the two ranges, and the rule shows "Driven by physics from …". This
happens by itself, also for the default rules; it is skipped when a rule
already writes the driving parameter (on most models the head angle drives
the hair, and a rule on the hair must not turn the head).

## Voice lipsync

Under **Voice lipsync** in the settings' **General** tab, pick the microphone (or keep **Default microphone**,
the browser's choice) and choose **Start microphone**. The names of the
microphones appear once the browser has been allowed to use one. The status shows
"● Microphone on" in red while it is on. Audio is processed locally and never
recorded, stored or sent.

The mouth follows the microphone through Mochi2D's live lip sync. It keeps
running while the window is hidden or minimized, so a stream has no gaps.

**Mouth opening from** decides how the microphone and the camera combine:

- **Camera only**: the microphone does not move the mouth;
- **Microphone only**: the camera does not move the mouth;
- **Whichever is wider (max)**: the larger of the two;
- **Add both**: the tracked opening plus the microphone;
- **Blend**: a slider between camera and microphone.

Without a face in view, the microphone moves the mouth alone (except in
"Camera only"); with the microphone off, the camera does.

**Microphone sensitivity** scales Mochi2D's default sensitivity (1). Raise
it if the mouth barely opens. The meter shows the microphone's level.

Under **Advanced**, the **noise gate** (default −45 dBFS) keeps the mouth
closed for sounds quieter than it. Stay quiet, watch the meter, and set the
gate (the line on the meter) just above where the level sits. The meter only
displays the level; nothing is recorded or stored.

How it works: every frame, Mochi2D combines its lip-sync value with the
mouth parameter: it adds it, or, for "Whichever is wider", takes the larger
of the two. Mochi Studio sets the mouth's base value, how they combine, and
the lip-sync sensitivity so that the result is the mode's.

### Simple or advanced

**Lipsync type** chooses how much the microphone tells:

- **Simple**: the volume opens the mouth (everything above).
- **Advanced**: Mochi2D's analysis also tells the vowels apart, A, I, U, E
  and O. The volume still opens the mouth as above, and the vowels become
  inputs for the mapping:
  - `VoiceA`, `VoiceI`, `VoiceU`, `VoiceE`, `VoiceO` and `VoiceSilence`,
    from 0 to 1 (they add up to 1);
  - `VoiceVolume`, from 0 (quiet) to 1 (your usual speaking level);
  - three made from these, for rigs made for them, all Mochi Studio's
    own approximations, as their exact definitions are not documented:
    - `VoiceFrequency`, one mouth shape from the vowels, for models with a
      single mouth-shape parameter: it rests at 0.5, and each vowel moves
      it by its weight (**Voice frequency**, −1 to 1 each) times how
      clearly it is heard, between 0 and 1. The default weights are Mochi
      Studio's: I up to 1, O down to 0, A near the middle;
    - `VoiceVolumePlusMouthOpen`: `VoiceVolume` plus the camera's mouth
      open, at most 1;
    - `VoiceFrequencyPlusMouthSmile`: the camera's mouth smile (0 to 1, 0.5
      at rest) plus how far `VoiceFrequency` moved from its 0.5, between 0
      and 1. (Both rest at 0.5, so a plain sum would read 1 with a still
      face.)

    Without the microphone, the two "Plus" inputs follow the camera alone,
    and without a face, the voice alone.

Switching to advanced runs the lipsync's own setup once: `VoiceA` …
`VoiceO` go to `ParamA` … `ParamO`, and `VoiceSilence` to `ParamSilence`,
where the model has those parameters. **Set up the vowel mapping** does it
again. For other models, map the voice inputs yourself in the Model tab's
mapping (for example `VoiceA` to a wide-open mouth shape).

**Models without vowel parameters.** When the model has none of `ParamA` …
`ParamO` but has a mouth form (`ParamMouthForm`), the setup lets the vowels
shape the mouth form instead: I and E widen the mouth, U and O round it,
and A leaves it nearly as it is. The vowels move it by up to half its range
on top of what the camera's smile gives, and silence leaves it to the
camera. Untick **Vowels shape the mouth** to turn it off (it then stays
off, also after switching the lipsync type).

The meter under the type shows what is heard: silence and the five vowels.

- **Mouth shapes** (for models with a motion-sync file): choose one of the
  model's settings, and its own shapes move the mouth, as its author made
  them. The voice inputs keep coming. The file's own per-parameter
  smoothing (`Smooth`) is not applied, as Mochi2D does by default: the
  analysis smooths the shapes itself, with the setting's own rates, and
  the file's dead band (`Damper`) still applies.
- **Browser voice processing** is off by default for the advanced type:
  echo cancellation and noise suppression blur the vowels. Turn it on in a
  noisy room.

**Your voice.** The analysis starts with a neutral voice that suits most
people. To have yours read better:

1. Under **Your voice**, type a name and choose **New voice**.
2. Press **A** and say "a" for about a second; do the same for I, U, E and
   O.
3. Press **Silence** and stay quiet for a second: the room's noise sets the
   gate.

The voice is used once all five vowels are recorded. Press a vowel again
to record it again. Voices are kept in this browser for every model, as the
vowels' spectra only (no recording is kept); choose one under **Voice**, or
the neutral voice.

## Items

Items are props, such as an umbrella or a hat, drawn over the model. An item
is itself a model folder (or zip) with a `.model3.json`; it animates on its
own (physics, breathing).

Open **Items** from the main menu:

- **Add item folder…** / **Add item zip…** adds one to the current model;
- an image file (PNG, JPEG, GIF or WebP) dropped on the stage becomes an
  item too: a flat picture, at most 2048 pixels a side;
- **animated items:** an animated GIF dropped on the stage, or a folder of
  PNG frames (a folder without a `.model3.json`, added with **Add item
  folder…** or dropped on the stage) becomes an animated item. Frames play
  in the order of their file names (`frame2.png` before `frame10.png`), all
  at the first frame's size. Up to 1024 frames; long or large animations are
  scaled down to fit four 2048-pixel textures;
- for an animated item, **Frame rate** (0 to 60 frames per second; 0 holds
  the frame shown) and **Play** / **Pause**. A GIF starts at its own speed
  (from its frame delays), a folder at 10 frames per second. A GIF whose
  frames have delays of their own keeps them: its frame rate is then a
  speed (the Items sheet shows its normal speed; twice that plays it twice
  as fast);
- **Show** shows or hides it (hotkeys can too);
- **X**, **Y**, **Scale**, **Rotation** place it, in the model's units; you
  can also drag it on the stage;
- **In front of the model** draws it in front or behind;
- **Pin to model** attaches it to the part of the model under its anchor
  (pinning), so it follows the body as the model moves.

On the stage (see [Mouse on the stage](#mouse-on-the-stage)): drop an item
on the model to pin it, and the log names the art mesh it is pinned to. If
an item ends up on a mesh that is only shown sometimes (an overlay such as
a blush, or a hand in some poses), drag it again, a little to the side.
Double-click an item to lock it, Ctrl+click (Command+click) to flip it
(**Flipped** in the Items sheet does the same), and drag it to the trash,
or off the window, to remove it.

Plugins can load items too, and show pictures they send if you allow it
([plugins.md](plugins.md#items)). Such items last for this session; the
Items sheet marks them, and **Keep it** keeps one like an item you added.

**Between the model's layers.** A plugin can put an item just in front of
one of the model's art meshes (a hat under the front hair, for example),
and split a model item in two (a scarf's front in front of the neck, its
back behind it). The Items sheet then says where the item is drawn, and
**Draw it whole** puts it back in front of (or behind) the whole model;
so does changing **In front of the model**. The place and the order among
items are saved with the item layout and shown in output views too. A
place on an art mesh this model lacks is kept for a model that has it;
until then the item is drawn on its side.

Items, their placement and pins are saved with the model's settings. The
item files are kept in this browser only (IndexedDB) and are not part of an
exported settings file: after importing settings on another computer, add
the items again.

### Web items (desktop app)

A web item is a web page drawn as an item: a chat, an alert box, a
counter. It is in the desktop app only; a browser page cannot draw another
site's page into a picture, and the Items sheet says so there.

In the Items sheet, open **Web item**, type the page's address (`http://`
or `https://`), its size in pixels (16 to 1920 a side; 640 × 360 to start)
and how often it is redrawn (1 to 30 frames per second; 10 to start), then
**Add web item**. It is then an item like any other: place it, scale it,
pin it, show and hide it, make scenes with it. Output views (OBS) show the
page too, sent to them as pictures at the item's frame rate at most.

What a page can and cannot do:

- it runs in a hidden window of its own, with its own cookies and storage,
  apart from Mochi Studio's: it cannot reach Mochi Studio, its settings,
  your files, the camera, the microphone, notifications or any other
  permission (all are refused);
- it is muted, and you cannot click or type into it: it is a picture;
- it cannot open new windows, download files, or go to another site (links
  and redirects to other addresses are stopped; the same site is fine);
- it cannot load Mochi Studio's own addresses (the bridge, the phone
  page), and those are refused as a web item's address too;
- it keeps running while it is shown or hidden, until you remove the item
  or open another model. After a restart it is loaded again.

A page that needs you to sign in will show its sign-in page: the item's
window has no cookies of yours.

### Item scenes

A scene is a set of items where they are now: turning it on shows them in
those places, turning it off hides them.

- Place the items, then **New scene from the items…** in the Items sheet.
  Tick the items it holds (those shown now start ticked), give it a name,
  and, if you like, a **group**: turning one scene of a group on turns the
  group's others off.
- **On** / **Off** tries it; **Edit** changes its name, group or items
  (taken where they are then); ✕ removes the scene, not its items.
- **Make hotkey** adds a **Toggle item scene** hotkey for it (Settings →
  Hotkeys), with a fade and a way to turn off again, as below.

**Item scenes** in the main menu opens the Items sheet at its scenes.
Scenes are saved with the model's settings, output views show them as the
window does, and agents can list, make, switch and remove them
([agent-api.md](agent-api.md)).

## Hotkeys and buttons

In the settings' **Hotkeys** tab, add a hotkey, click its key button and
press its keys: up to two keys held together, plus any modifiers (for
example `Q+W` or `Ctrl+Shift+1`), or a mouse button (middle, right, back,
forward), with modifiers if you like. The left button counts only with a
modifier, as **Alt+click** and the like, and only as a click: a plain
click, or dragging the model, never fires a hotkey. Some Linux desktops
take Alt+click for themselves (to move windows); Ctrl+click or Shift+click
work instead. A game
controller's buttons and stick directions count as keys too, alone or with
a key held (`Q` and the left stick up). The combination is set when you let
go of the keys; Esc clears it. Actions:

- **Expression**: toggles an expression on and off. Several can be on at
  once: they layer, each fading in and out with its file's fade times;
- **Animation**: plays an animation once, or plays it and holds its last frame
  (press the hotkey again to release it). A held pose wins over tracking;
- **Item**: shows or hides an item;
- **Toggle item scene**: turns an [item scene](#item-scenes) on or off, its
  items fading in and out over the seconds you set;
- **All expressions off**;
- **Calibrate** (with the camera on).

Expression, item and item scene hotkeys can turn off again in three ways
(an item scene by itself after up to an hour):

- **Press: on / off** (the default): each press switches it;
- **On while held**: on while the keys (or the on-screen button) are held,
  off when you let go;
- **On for some seconds**: off by itself after the seconds you set (a press
  while it is on turns it off at once).

**Which window must have focus.** In a browser, hotkeys work while the
Mochi Studio window has focus. A web page cannot see keys pressed in other
apps, by design, so that no site can read what you type elsewhere. To press
hotkeys while a game or OBS has focus, use the desktop app
([desktop.md](desktop.md#hotkeys-in-other-apps)), or the on-screen buttons
in an OBS dock.

Hotkeys with **Button** checked also appear as buttons down the right side
of the stage, for touch screens: up to eight (the first eight in the list).
Mouse-button hotkeys work only while the Mochi Studio window has focus, also
in the desktop app. Controller hotkeys work while Mochi Studio gets the
controller: browsers usually give it only to the window in front; the
desktop app reads it in the background too, where the system allows.

### Gestures

A hotkey can also fire on a hand gesture, while the camera tracks the
hands ([Hand tracking](#hand-tracking)). Open the hotkey's **Gesture** and
choose:

- a gesture for **Your left hand**, **Your right hand**, or both; with
  both, **Combine** says whether both must show theirs (**Both (AND)**) or
  either is enough (**Either (OR)**);
- or, under **Or both hands**, a two-hand pose instead: **Hands together**
  (the palms closer than an eighth of the picture's width);
- **Either hand (mirrored)**: also when the hands are the other way round
  (the left hand's gesture on the right hand, and the right's on the
  left);
- **Hold (s)**: how long the gesture must last before the hotkey fires (0
  to 10 seconds, default 0.5).

The hotkey fires once the gesture has lasted its hold time, and again only
after the gesture has ended. "On while held" hotkeys turn off when the
gesture ends. Left and right are your own hands, whatever the mirror
setting. The keys and the button keep working as well.

The gestures, from how straight each finger is (a finger counts as
straight from 0.65 and as curled up to 0.4; a half-bent finger fits no
gesture) and whether the thumb and index tips touch (closer than a quarter
of the hand's length, wrist to middle knuckle):

| Gesture    | Thumb                    | Index      | Middle   | Ring and pinky |
| ---------- | ------------------------ | ---------- | -------- | -------------- |
| OK sign    | its tip on the index tip | not curled | straight | straight       |
| Pinch      | its tip on the index tip | not curled | any      | any            |
| Open hand  | straight                 | straight   | straight | straight       |
| Fist       | not straight             | curled     | curled   | curled         |
| Point      | any                      | straight   | curled   | curled         |
| Peace sign | any                      | straight   | straight | curled         |
| Thumbs up  | straight, pointing up    | curled     | curled   | curled         |

They are tried in this order, so an OK sign is not also a pinch.
"Pointing up": within about 50° of straight up in the picture. A thumb
held out sideways or down, with the other fingers curled, is no gesture.

**Gesture sensitivity** (Camera tab, while hands are tracked): a slider
per gesture and for **Hands together**, from 0 to 100 (50 is the
default). Higher recognizes the gesture more easily, and more often by
mistake: from 0 to 100, "straight" goes from 0.75 to 0.55, "curled" from
0.3 to 0.5, "pointing up" from about 30° to 65°, touching tips from 0.15
to 0.35 of the hand's length, and "together" from 1.5 to 3.5 position
units. The hand preview shows what is recognized as you move the sliders.

### Expressions

Below the hotkeys, the **Expressions** list has the model's expressions:

- **On** / **Off** tries one, no hotkey needed (output views show it too);
- **Edit** opens it in the expression editor; **Export** downloads its
  `.exp3.json` file;
- **Create hotkeys for … expressions without one** adds a hotkey (no keys
  yet, no button) for each expression that has none.

**New expression** (or **Edit**) opens the editor:

- tick the parameters it moves, and give each a value and a mode: **Set
  to** (the parameter takes the value), **Add** (added to what it has) or
  **Multiply by** (1 changes nothing, −1 turns a tracked movement around);
- **Fade in** and **Fade out**, in seconds;
- **Show it on the model while editing** shows it at once, in this window
  only;
- parameters that physics overwrites are marked: physics sets them every
  frame, so an expression cannot move them.

**Save**: in the desktop app, the expression is written into the model
folder as an `.exp3.json` file, next to the model's other expressions. In
a browser it is kept with the model's settings in this browser; **Export**
gives you the file. An expression you made can be removed; one of the
model's own that you changed can go back to its file (**Undo changes**).

**Undo and redo.** The ↶ and ↷ buttons at the top right, or Ctrl+Z and
Ctrl+Shift+Z (Ctrl+Y), undo changes to mappings, lip sync, background,
position, frame cap, items, expressions and parameter values, whether you
or an agent made them.

## Plugins

Plugins made for VTube Studio (stream tools, stream decks, controllers,
audio meters) connect to Mochi Studio unchanged. Switch on **Plugin
server** in the settings' General tab; each plugin asks you before it can do
anything, and tracking data stays private unless you allow it per plugin.
A plugin that wants to show its own pictures, or to have you choose parts
of the model, asks you on the stage first.
See [plugins.md](plugins.md).

## Agents

Programs and AI agents (Claude and other MCP clients, chat bots) can control
the avatar through a small bridge that runs on this computer. It is off
until you turn it on:

1. Start the bridge: `npm run bridge` in the Mochi Studio folder. It prints a
   six-digit pairing code (`npm run bridge -- status` shows it again). The
   same bridge also carries output views to OBS; you pair a window once for
   both.
2. In the settings' **General** tab, under **Agents**, tick **Agent access** and enter the code.
3. Under **Tokens**, create a token for each agent, with what it may do:
   read the state, control the avatar, take screenshots. Copy the token and
   the setup snippet shown with it into the agent's settings. You can revoke
   a token at any time.

While an agent is connected, the status shows "● Agent: <name>", and the
General tab lists the agents and their recent commands. Agents never get
camera or microphone data, and cannot turn the camera or microphone on.
Details and setup for each MCP client: [agent-api.md](agent-api.md).

## Output for streaming (OBS)

The output view shows only the avatar on the chosen background. It follows
the control window: model, tracking, lip sync, expressions, motions, items,
background and position. It never opens the camera or microphone.

In the settings' **Camera** tab, under **Output** (the main menu's
**Background** opens it there):

- **Background**: **Transparent background**, chroma key (green, blue, magenta or any
  color), solid color, or an image (fill or fit). Background and frame cap
  apply to all models, unless you tick **Use a different background and
  frame cap for this model**.
- **Position**: drag the stage to move the model, scroll to zoom, Shift+drag
  to turn it, or type the values (**Lock model position** in the main menu
  keeps it where it is). The model turns about its own center, and
  dragging moves it on screen whatever its rotation.
- **Frame rate**: cap the rendering rate (24, 30, 60, 120 or uncapped).

### OBS setup

OBS's Browser Source runs in its own browser profile, so it cannot hear the
control window directly. The local bridge carries everything to it:

1. Run Mochi Studio (`npm run dev`, or serve the `dist/` build) and open it
   in your browser, for example `http://localhost:5173/`.
2. Start the bridge on the same computer: `npm run bridge`. It prints a
   six-digit pairing code. (`npm run bridge -- status` shows it again.)
3. In the settings' **Camera** tab, tick **Output views through the bridge**, and
   enter the pairing code the first time.
4. Copy the address that appears (it ends in `&view=msv_…`) and add a
   **Browser** source in OBS with it, at the size of your canvas. Leave
   "Custom CSS" empty so the background stays transparent.
5. For a transparent background choose **Transparent background** in the Camera tab; for
   a chroma key choose **Chroma key** and add OBS's Chroma Key filter to the
   source.

That is all OBS needs: the running bridge and the address. The desktop app
([desktop.md](desktop.md)) has the bridge built in: there, step 2 and the
pairing are not needed.

The Camera tab shows each view's loading progress, and how far the model's
files are uploaded to the bridge (the page uploads them once, as soon as
bridge views are on, so views that open later load quickly). The view loads
the model's and items' files from the bridge as it needs them, so large
models work too, and it follows the control window: tracking, lip sync,
expressions, motions, items, background and position. It never opens the
camera or microphone.

While a view loads a model, the control window draws at 2 frames per second
(for at most a minute). Pages of one browser share its graphics process, and
without a graphics card the control window's drawing held a loading view
back. A view in OBS runs in OBS's own process, so this matters less there.

The address is display only: it cannot change anything, and it is not an
agent token. **New address** makes a new one (the old one stops working).
The status's **Output views** count includes views connected through the
bridge.

The address without the bridge (`…/output.html`, in the output settings) works only in the same browser profile as the control window: another
tab or window of that browser, which you can capture with a Window Capture
source.

Only one control window drives the bridge: if you open Mochi Studio in a
second window and turn on the bridge there, it takes over, and the first
window says so.

### OBS with Spout2 (Windows, desktop app)

On Windows, the desktop app can send the avatar to OBS with **Spout2**: the
frames stay on the graphics card, nothing of the window around the avatar is
included, and the background is transparent.

1. In OBS, install the Spout2 plugin for OBS ("Spout2 Plugin for OBS
   Studio", a third-party plugin), in the version that matches your OBS.
2. In Mochi Studio's settings, **Camera** tab, under **Spout2**, tick
   **Send as MochiStudio**.
3. In OBS, add a **Spout2 Capture** source. As the sender, pick
   **MochiStudio**, or **first available sender** if it is the only one.
4. In the source's settings, set the **composite mode** to **premultiplied
   alpha**. Mochi Studio sends premultiplied color, so half-transparent
   parts (hair tips, glow, a faded item) look right only in that mode.

Each output has these settings:

- **Mirror** flips it horizontally.
- **Fixed size** sends that size (16 to 7680 pixels a side). Without it, the
  output has the stage's size in the window, and follows it when you resize
  the window. A fixed size larger than your screen is drawn at a smaller
  size and scaled up. On a test machine without a graphics card, such an
  output stayed empty, and it has not been checked on a real graphics card
  yet. If it stays empty, pick a size that fits your screen.

**Add an output** adds another sender, **MochiStudio2**, then
**MochiStudio3** and **MochiStudio4**, each with its own settings: one
mirrored, say, or one at a fixed size for a second scene. The status line
under each says what it sends, and whether its frames stay on the graphics
card or go through memory. They stay on the card when Windows and the
graphics driver allow it; otherwise the app reads them back, which costs
some CPU.

**On a laptop with two graphics chips,** run Mochi Studio and OBS on the same
one, the dedicated one (Windows: Settings → System → Display → Graphics). If
they run on different chips, OBS's Spout2 source stays black.

Agents can switch the outputs too (`set_spout`), and `get_state` shows each
sender ([agent-api.md](agent-api.md)).

### A virtual camera for calls (Linux, desktop app)

The desktop app on Linux can send the avatar as a camera named **Mochi
Studio Camera**. Discord, Zoom, Meet in a browser, OBS and other apps then
list it with your other cameras. Windows and macOS follow.

**Once, before the first use,** install v4l2loopback and load it with the
camera's name. The Camera tab shows these lines while the camera is
missing:

```sh
sudo apt install v4l2loopback-dkms      # Debian, Ubuntu (Fedora: dnf, from RPM Fusion; Arch: pacman)
sudo modprobe v4l2loopback devices=1 video_nr=10 card_label="Mochi Studio Camera" exclusive_caps=1
```

- **Loading needs `sudo`.** Mochi Studio never asks for it. It finds the
  camera a moment after it is loaded.
- **`exclusive_caps=1`** lets Chromium-based apps (Chrome, Discord, many
  call apps) list the camera.
- **To load it at every start:**
  - put `v4l2loopback` in a file in `/etc/modules-load.d/`;
  - put `options v4l2loopback devices=1 video_nr=10 card_label="Mochi
Studio Camera" exclusive_caps=1` in one in `/etc/modprobe.d/`.
- **With Secure Boot,** the distribution asks you to sign the module when
  it installs (a key you enroll at the next start).

**Then,** in the Camera tab, under **Virtual camera**:

1. Tick **Send as a camera**.
2. In the call app, choose **Mochi Studio Camera** as the camera.

The settings:

- **Size:** 1280 × 720 (the default), 1920 × 1080 or 960 × 540, at 30 or 60
  frames a second. Apps choose from these sizes, so the camera keeps its
  size when you resize the window. The stage is fitted inside it.
- **Background:**
  - **The stage's** (the default): the background you see on the stage. If
    that is transparent, the camera shows black around the avatar.
  - **A color,** with **Key green** for apps that can key it out. Video
    apps show no transparency; for that, use Spout2 or an output view in
    OBS.
- **Mirror:** off by default. Call apps already mirror your own preview,
  and send the picture the right way round.

The status line says what the camera sends and to which device. Another
loopback device, such as OBS's own virtual camera, is left alone: Mochi
Studio writes only to the one with its name.

Agents can set the camera too (`set_virtual_camera`), and `get_state` shows
it ([agent-api.md](agent-api.md)).

## Collaborating

Several people's avatars can share one stage. Each person's app shows
everyone, and each person streams their own screen. The design is in
[collaboration.md](collaboration.md).

**Before the first session,** in **Settings → Collab**:

- **Nickname:** what the others see. Nothing else about you is shown.
- **Signaling server:** the server that introduces the apps to each other.
  Mochi Studio comes with none set. To host, you need one: run your own
  (see [Hosting a server](collaboration.md#hosting-a-server)), or use one
  a friend runs. To join, an invitation link brings its own address; a
  code needs this setting.
- **Hide my address** (on): your app connects only through the server's
  relay, so the others never see your IP address. If the server has no
  relay, the app says so and doesn't connect. Switch this off only for
  people you trust.
- **My model goes to the others as:**
  - **Video only** (the default): the model's files never leave your
    computer; the others get a video of your avatar, transparent around it.
    It costs upload, about 2 Mbit/s for each other person, so the tab
    warns above three people. A smaller avatar on the stage sends a
    smaller video.
  - **Its files:** the others' apps get your model, encrypted, keep it in
    memory only, and drop it when you leave. Someone with the right tools
    could still copy it from memory during the session. Share only with
    people you trust, and never a model whose licence forbids it.
  - **Never its files:** video only, for good.

**Hosting:**

1. Set **People** (2 to 6) and **Updates a second** (10 to 60, 30 by
   default). Give a **Password** if you like: people need the invitation
   and the password, and a wrong one is declined without asking you (the
   tab counts how many). Then press **Start a session**.
2. **Show invitation** shows the link for 30 seconds, so it doesn't stay on
   stream. **Copy** copies it. Send it in a private chat. **Show code**
   shows the same invitation as a code to read aloud (`MOCHI-` and ten
   groups of five); it doesn't carry the server, so the person joining
   needs the same **Signaling server** setting.
3. **Make a new link** retires the old link and code, for example when
   one was seen on stream. People already in stay.
4. When someone asks to join, their nickname appears with **Let in** and
   **Decline**. Someone without the link can't produce a readable nickname,
   and is shown as such.
5. **Lock** stops new requests. **Remove** takes someone out, and their app
   can't ask again in this session. **End the session** ends it for
   everyone.

**Joining:** paste the link or type the code (case, spaces and dashes
don't matter, nor O for 0 or I and L for 1), add the password if the host
set one, and press **Ask to join**, then wait for the host. An old link
the host has replaced is refused.

**During the session,** each person's avatar stands where its owner puts
it, at the size it has on their screen.

- **Bring my avatar to the front** puts yours in front for everyone.
- **For each participant:**
  - **Hide** hides them on your screen only;
  - **Smoothing delay** (0 to 1 s) holds their movement back a little, to
    hide network stutter.
  - **Block** hides them and ignores what they send (expressions,
    motions), on your screen only. They aren't told.
  - **Place them myself** keeps their avatar where you drag it on your
    screen, not where they stand; **Pin to my model** then makes it
    follow your own model, like a pinned item.
- **My own order (front first)** lets you put people in front of or
  behind each other with ▲ and ▼, on your screen only.
- **Chat** sends a line of text (up to 500 characters) to everyone in the
  session. Nothing is kept: it is gone when the session ends.
- **Output views (OBS)** show everyone too, in the same places and order
  as your screen.
- **If your connection to the server drops,** the app reconnects by
  itself within a minute. The others keep seeing you meanwhile; only new
  people can't join until it's back.
- **Agents** can do the same through the agent API (`collab_host`,
  `collab_join`, `collab_answer`, `collab_chat`, `collab_place`…; see
  [agent-api.md](agent-api.md)).

## Streaming for hours

Mochi Studio is built to run through a long stream without slowing down or
stopping.

**Errors never stop the stage.** Each frame runs in steps (hand tracking,
the light overlay, the voice, tracking and parameters, items, drawing). If
one fails, the others still run, so the model keeps moving in the window
and in OBS. The error goes to the **Log** once, with a count while it
repeats, and pops up once. An output view's errors (in OBS too, through the
bridge) go to the control window's log, at most one a second. Errors
nothing else catches are logged too.

**For a bug report**, open the **Log** and press **Save for a bug report…**.
The file has the app's version, the browser, whether a model is loaded, the
number of items and output views, and the log. It never has a camera
picture, files, your name or addresses; still, read it before you send it.

**What was measured.** These numbers come from the automated tests, in a
container without a graphics card (Chromium's software WebGL, 4 processor
cores). The test model is synthetic, of DeepSeek-chan's size: 509
parameters, 715 art meshes, five 4096 × 4096 textures, physics and 23
expressions.

- **Memory:** three hours of stream events (tracking at 30 frames a second,
  a plugin injecting values and loading and unloading items, hotkeys,
  expressions, pictures added and removed, an output view reopened eleven
  times, the light overlay on), run in 20 minutes. After the first minute,
  the control window's script memory stayed between 10.3 and 11.1 MB, and
  an output view's between 6.2 and 7.4 MB. Graphics objects follow the
  items shown and return when items are removed. The test suite runs an
  hour of these events in 90 seconds on a small model, and fails if memory
  grows.
- **Per frame:** with that model, a frame of the control window takes
  about 3 ms of script, 2.8 ms of it in Mochi2D's evaluation and drawing
  calls. An output view takes about the same. At 60 frames a second the
  budget is 16.7 ms, so the script leaves room. The drawing itself is the
  graphics card's work. Without a card, software drawing manages only about
  3 frames a second of this model, so use a graphics card for a model this
  large.
- **Startup:** from launching the desktop app to the model on screen,
  3.3 seconds with the last model reopened (the window appears after 0.3 s);
  in the browser, 3.6 seconds from opening a `?model=` address. Most of it
  is decoding and uploading the four-thousand-pixel textures.

**Tips for long streams:**

- Close the settings while you stream: the live values in the Mapping tab
  are updated only while they are shown.
- With OBS on the same computer, use the bridge's output view address in a
  Browser Source. OBS draws it in its own process. A view in another tab of
  the same browser shares that browser's graphics process with the control
  window.
- A 60 frames a second cap (the default) is enough for streaming. Higher
  caps cost graphics time and are not seen at 60 frames a second.
- If something looks wrong, look at the **Log** first: a failing step says
  what failed, and the stage keeps running meanwhile.

## Privacy

- Camera and microphone are off until you turn them on, and the status at
  the top right shows in red while either is on.
- The camera picture is never shown unless you ask for it in the Camera tab
  (and then only there).
- The hand preview draws only the points the tracker finds, never the
  picture, and only in the Camera tab.
- Video and audio are processed in the page and are never recorded, stored or
  sent. The output view never opens the camera or microphone.
- MediaPipe's code and model are served by Mochi Studio itself; no data goes
  to a third party.
- The phone tracker is off until you turn it on. While on, it listens on
  one port of this computer's network addresses and serves only the phone
  page, MediaPipe's files and the tracking connection; a phone needs the
  pairing code first. The phone sends face values, never its camera
  picture ([A phone as the face tracker](#a-phone-as-the-face-tracker)).
- The light from the screen captures nothing until you start it, and keeps
  only three average colors of the picture: no picture is kept or sent,
  not even to the bridge ([Light from the screen](#light-from-the-screen)).
- Saved settings contain your calibration (neutral head pose values), mapping
  and hotkeys, not images or audio.

# Plugins

Plugins made for VTube Studio connect to Mochi Studio unchanged: Mochi
Studio speaks the same WebSocket API. Stream tools, stream decks,
controllers and audio meters can then trigger hotkeys, load and move the
model, switch expressions, tint the model and feed their own inputs into
the mapping.

The plugin server is **off** until you switch it on, listens on this
computer only, and every plugin asks you before it can do anything.

## Switching it on

- **Desktop app:** General tab → **Plugin server**. The bridge is built in.
- **Browser:** start the bridge (`npm run bridge`), then General tab →
  **Plugin server**, and enter the pairing code the bridge prints. Plugins
  connect to the bridge, so it must keep running; the page answers through
  it.

The status line shows the address plugins connect to, normally
`ws://localhost:8001`. When that port is taken, the next free one is used
(up to 8010) and shown; tell the plugin that port. While the server is on,
Mochi Studio also announces itself on the local network every 2 seconds
(UDP port 47779), as plugins that search for the app expect.

## Allowing a plugin

When a plugin connects for the first time, Mochi Studio asks whether to
allow it, with its name, developer and icon. Allow only plugins you
started yourself. An allowed plugin reconnects later without asking again.

The settings' General tab lists the allowed plugins, marks the connected ones, and
has for each:

- **May read tracking data** (off by default). Tracking data is what the
  camera and the microphone measure (head angles, eyes, mouth, hands,
  vowels) and the model values it drives. While it is off, the plugin reads default values instead. A
  plugin can always read the values it feeds in itself, whether a face is
  found, and plugins' own inputs. No plugin ever gets the camera image or
  the microphone's sound.
- **Permissions** the plugin was given, each with **Take back**. A plugin
  asks for a permission while connected, and Mochi Studio asks you, as for
  the plugin itself. The only one Mochi Studio can give is
  `LoadCustomImagesAsItems`: the plugin may show pictures it sends as items.
- **Revoke:** the plugin must ask again, and the inputs it created are
  removed. Mappings that use them stay, and work again if it creates them
  again.

The status shows connected plugins (● Plugin: …) as it does agents.

## Plugin inputs in the mapping

Plugins feed values into inputs, and the mapping turns inputs into model
parameters, with its smoothing, as for the camera:

- **Their own inputs** (custom parameters) appear in the mapping editor's
  input list as "Name (from the plugin …)". Add a rule from such an input
  to a parameter to use it.
- **Tracking inputs** under their usual names (`FaceAngleX`, `MouthOpen`,
  `EyeOpenLeft`…) replace or add to what the camera measures:
  `FaceAngleX` is the head turn, `MouthSmile` the mouth smile, and so on
  (the same table as the settings import). The voice inputs (`VoiceA` …
  `VoiceO`, `VoiceSilence`, `VoiceVolume`) are the advanced lipsync's
  inputs, so a plugin's values replace or add to what the microphone
  hears; so are `VoiceFrequency`, `VoiceVolumePlusMouthOpen` and
  `VoiceFrequencyPlusMouthSmile`, Mochi Studio's approximations (the user
  guide's [Simple or advanced](user-guide.md#simple-or-advanced)). The hand
  inputs (`HandLeftFound`, `HandLeftPositionX`, `HandLeftFinger_2_Index`,
  `HandDistance`…, see the user guide's
  [Hand tracking](user-guide.md#hand-tracking)) are the hand tracker's, in
  the same way, and `MousePositionX` and `MousePositionY` the mouse's
  ([Mouse and controller](user-guide.md#mouse-and-controller)). Names that
  Mochi Studio has no tracker for (`TongueOut`, `FaceAngry`) become inputs
  of their own. The controller and mocopi inputs are not in this list:
  Mochi Studio lists only the documented default inputs.
- **Reading them:** `ParameterValueRequest` and `InputParameterListRequest`
  give the tracked inputs' values, the voice and hand inputs included, only
  to plugins you allowed to read tracking data (Agents tab). Others get the
  defaults (0, and 1 for `VoiceSilence`), with their own values as sent.
- **Found or lost:** `TrackingStatusChangedEvent` comes when the face or a
  hand is found or lost, with `faceFound`, `leftHandFound` and
  `rightHandFound` (the hands named as the hand inputs name them, so
  mirrored like them). Like `FaceFoundRequest`, it goes to every
  subscribed plugin; the hand inputs' values stay private as above.

A plugin that stops sending loses its values after one second.

## What plugins can do

| Area        | Requests                                                                                                                                                                                     | Notes                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Connecting  | `APIStateRequest`, `AuthenticationTokenRequest`, `AuthenticationRequest`, `PermissionRequest`                                                                                                | `LoadCustomImagesAsItems` after you allow it; `ControlNDISettings` is never granted (no NDI)                                                                                                                                                                                                                                                                                                                                                                     |
| State       | `StatisticsRequest`, `VTSFolderInfoRequest`                                                                                                                                                  | "Window" is the stage; `startedWithSteam` is false; folder names are Mochi Studio's own (names only, no folders on disk)                                                                                                                                                                                                                                                                                                                                         |
| Models      | `CurrentModelRequest`, `AvailableModelsRequest`, `ModelLoadRequest`, `MoveModelRequest`                                                                                                      | Available: the current model, and in the desktop app the recent folders and zips. 2 s between loads                                                                                                                                                                                                                                                                                                                                                              |
| Hotkeys     | `HotkeysInCurrentModelRequest`, `HotkeyTriggerRequest`                                                                                                                                       | By ID or name; one queued hotkey runs every 5 frames, 32 at most                                                                                                                                                                                                                                                                                                                                                                                                 |
| Expressions | `ExpressionStateRequest`, `ExpressionActivationRequest`                                                                                                                                      | Several at once; each with its file's fades                                                                                                                                                                                                                                                                                                                                                                                                                      |
| Inputs      | `FaceFoundRequest`, `InputParameterListRequest`, `ParameterValueRequest`, `Live2DParameterListRequest`, `ParameterCreationRequest`, `ParameterDeletionRequest`, `InjectParameterDataRequest` | Set and add modes; tracking data private as above                                                                                                                                                                                                                                                                                                                                                                                                                |
| Art meshes  | `ArtMeshListRequest`, `ColorTintRequest`, `ArtMeshSelectionRequest`, `ArtMeshAtPositionRequest`                                                                                              | Selection: you choose in a list beside the stage (below). Tints darken the matched art meshes, here and in output views; the latest request wins, white clears, and a plugin's tints end with its session. At a position: Mochi Studio's hit tests, with `visualize` dots in this window                                                                                                                                                                         |
| Items       | `ItemListRequest`, `ItemLoadRequest`, `ItemUnloadRequest`, `ItemMoveRequest`, `ItemPinRequest`, `ItemAnimationControlRequest`, `ItemSortRequest`                                             | See "Items" below                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| Physics     | `GetCurrentModelPhysicsRequest`, `SetCurrentModelPhysicsRequest`                                                                                                                             | The model's physics groups and your strength, wind and multipliers; overrides for 0.5–5 s each, one plugin at a time (see "Physics" below)                                                                                                                                                                                                                                                                                                                       |
| Scene       | `SceneColorOverlayInfoRequest`, `PostProcessingListRequest`, `PostProcessingUpdateRequest`, `NDIConfigRequest`                                                                               | The light overlay as it is (the Camera tab's **Light from the screen**): off and white until the person starts it, then the parts, the average, the settings and the final color. Mochi Studio has no post-processing effects and no NDI output: post-processing not supported, NDI off. The documented errors and the NDI cooldown still apply                                                                                                                  |
| Events      | `EventSubscriptionRequest`                                                                                                                                                                   | Sent: `TestEvent`, `ModelLoadedEvent`, `TrackingStatusChangedEvent`, `BackgroundChangedEvent`, `ModelConfigChangedEvent`, `ModelMovedEvent`, `ModelOutlineEvent`, `HotkeyTriggeredEvent`, `ModelAnimationEvent`, `ItemEvent`, `ModelClickedEvent`, `ExpressionToggledEvent`, `ArtMeshTrackingEvent`, `ArtMeshOutlineEvent`; `Live2DCubismEditorConnectedEvent` once on subscribing (never connected). `PostProcessingEvent` can be subscribed to and never fires |

Every documented request is answered; only unknown message types get
"unknown request" (error 7).

### Items

- Items are Mochi Studio's items (props drawn with the model). An item's
  `fileName` is the folder, zip or image it came from; loading a
  `fileName` copies an item that came from it.
- **Items a plugin loads last for this session.** The Items sheet marks
  them, and **Keep it** stores one like an item you added yourself.
- **Pictures a plugin sends** (`customDataBase64`) need the
  `LoadCustomImagesAsItems` permission. PNG, JPEG and GIF (its first frame)
  only, 64 to 2048 pixels a side, under 5 MB; anything else is refused
  (error 758). With `customDataAskUserFirst`, Mochi Studio shows you the
  picture and asks; a picture you accepted is not asked about again in this
  session unless the plugin says so. Mochi Studio names the picture itself
  (`plugin-….png`), and that name loads it again until the page reloads.
- **Order:** slots −30 to 30 without 0 (the model's). Positive slots are in
  front of the model, negative ones behind it; higher slots are drawn on
  top.
- **Size:** 0.32 is an item at its own size, as when you add it by hand.
- **Moves** fade with Mochi Studio's own curves for each `fadeMode`;
  grabbing the item stops a move unless `userCanStop` is false.
- **Pins:** to the given triangle, the middle one (`Center`) or a random
  one, with the angle and size modes. A pinned item turns with its
  triangle, so `RelativeToModel` and `RelativeToPinPosition` behave alike.
- **Animated items** (an animated GIF, or a folder of PNG frames) report
  `type` `GIF` or `AnimationFolder`, `framerate`, `frameCount` and
  `currentFrame`. A plugin's own GIF with two or more frames becomes one.
- **Animation controls:** for animated items, `framerate` (the protocol's
  0.1–120; Mochi Studio plays at most 60), `frame`, auto-stop frames and
  the play state all work; a frame the item does not have answers 852, like
  an invalid auto-stop frame. Still pictures answer 854 and model items 851
  for frame controls. `opacity` works for every item. `brightness` darkens a
  still picture with a black overlay, and animated and model items with a
  gray tint over all their art meshes.
- **Sorting** (`ItemSortRequest`, Mochi2D 0.10.0's items between layers):
  - an art-mesh order puts the item (its front part) just in front of that
    art mesh of the model; `FullyInFront` and `FullyInBack` put it in front
    of or behind the whole model;
  - a model item splits at `splitAt`: that art mesh and the ones drawn
    after it are the front part, the rest the back part, at
    `withinModelOrderBack` (an art mesh, or `FullyInBack`). The back part
    is never drawn in front of the front part;
  - `frontOn: false` leaves the item on its side of the model, and
    `backOn: false` draws a model item whole. The orders and the split
    point are kept, so a later request can leave them `Unchanged` and only
    turn a part on or off. `setSplitPoint: UseSpecialID` clears the split
    point. Image items ignore the back part and the split point;
  - an art mesh the loaded model lacks is accepted and kept: the item stays
    on its side until a model with that art mesh is loaded;
  - `loadedModelHadRequestedFrontLayer` (and `…BackLayer`) is true when the
    request set that order and the loaded model has it (an art mesh it
    has, or a special ID); false when it left the order unchanged or names
    an art mesh this model lacks;
  - the places and the order among items are saved with the item layout,
    survive a reload and reach output views.
- **Flipping** (`flipped`, `setFlip`) mirrors any item about its anchor; a
  pinned item stays pinned.
- `censored` and `smoothing` are kept and reported, but change nothing.

### Choosing art meshes

`ArtMeshSelectionRequest` opens a list of the model's art meshes on the
left of the stage, with the plugin's name and text. Tick the ones to send,
or click the model to list only those under the pointer (**Show all**
brings the full list back). **OK** sends your choice; **Cancel** answers
`success: false` with the plugin's preselection unchanged. A plugin that
disconnects meanwhile closes the list.

### Tracked points and mesh outlines (beta)

- **`ArtMeshTrackingEvent`** reports each point's position (window
  coordinates, as everywhere), whether its art mesh is visible, its
  rotation (the base angle plus how far its triangle has turned on screen
  since the subscription, clockwise) and its size (the base size times how
  much its triangle has grown). Points of another model, or of an art mesh
  the model lacks, are not found. Default frequency: 30 per second.
- **`ArtMeshOutlineEvent`** reports each art mesh's rings (one per
  connected piece, and per hole), 20 evenly spaced points each, and their
  areas added up. The rings are found once per subscription; only their
  positions update. Default frequency: 15 per second.
- **`ExpressionToggledEvent`** comes for every change, and once per
  expression when a model loads; with `sendAllActiveStatesOnSubscription`,
  once per expression right after subscribing. Both snapshots say
  `justLoaded: true`.

### Physics

The Model tab has the person's physics settings, saved per model: a
strength and a wind from 0 to 100, and a multiplier from 0 to 2 for each
physics group (Mochi2D's physics settings, named from the physics file).
`GetCurrentModelPhysicsRequest` reports them, with each group's
`groupID` (the setting's ID) and `groupName` (its name in the physics file,
or empty when the file does not name it).

How the protocol's values become Mochi2D's (src/core/physicsTuning.ts):

| Protocol                           | Mochi2D                                                       | So                                                                                                                                                                                                                                                                                                |
| ---------------------------------- | ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `baseStrength` 0–100               | `setPhysicsStrength(baseStrength / 50)`                       | 50 is the model as made (1, exact); 0 is the same as physics off; 100 doubles every swing, within each parameter's range                                                                                                                                                                          |
| a group's `strengthMultiplier` 0–2 | `setPhysicsSettingStrength(groupID, multiplier)`              | Mochi2D multiplies it by the model's strength                                                                                                                                                                                                                                                     |
| `baseWind` 0–100                   | `setPhysicsWind(x, y)`, with a peak of (baseWind / 100, 0)    | Smooth random gusts whose direction drifts slowly across both sides: x is 30% to 100% of the peak times the direction (−1 to 1, crossing sides about every half minute), y up to ±20% of the peak, on the wall clock (every window the same). At 100 the strongest gusts are as strong as gravity |
| a group's `windMultiplier` 0–2     | `setPhysicsSettingWind(groupID, multiplier)` (Mochi2D 0.13.0) | The group feels the wind times its multiplier: 0 shields it, 1 is as the rest. The Model tab sets the person's, and a plugin's override takes its place for its time                                                                                                                              |

`SetCurrentModelPhysicsRequest`:

- An override replaces the person's value while it lasts: the base
  strength or wind (`setBaseValue: true`, 0–100) or a group's multiplier
  (0–2). Values are limited to those ranges.
- Each override has its own timer, `overrideSeconds` limited to 0.5–5 s
  (0.5 when missing). Repeat the request to keep it. Overrides are not
  saved, and the Model tab says which plugin is changing the physics.
- The first plugin to override has control; another gets 702 until all of
  the first one's timers have run out. A plugin's overrides end with its
  session, and when the model changes.
- Overrides cannot switch physics on: with the person's switch off, they
  change nothing you see.
- `GetCurrentModelPhysicsRequest` shows the person's values, not the
  overrides, with `apiPhysicsOverrideActive` and
  `apiPhysicsOverridePluginName` while a plugin has control.
- Errors, in this order: 700 (no model), 701 (no physics), 702 (another
  plugin), 703 (no overrides), then entry by entry 705 (no value), 704 (no
  such group) and 706 (a group, or the base value, twice in one list). A
  refused request changes nothing.

### The model's outline

`ModelOutlineEvent` is the convex hull of the corners of the visible art
meshes' bounding boxes, 15 times a second. With `draw: true`, Mochi Studio
draws it as a dashed line on the stage, in this window only (never in
outputs).

### Screen overlay hotkeys

A **Screen overlay** hotkey reports the type `ScreenColorOverlay`; plugins can
trigger it like any hotkey. `SceneColorOverlayInfoRequest` reports the light
whether it comes from a capture or the static color (then
`isWindowCapture` is false and every part has the static color).

### Hotkeys' keys

`HotkeysInCurrentModelRequest` lists each hotkey's keys in `keyCombination`
under the API's key names, modifiers first: `Ctrl+Shift+KeyA` is
`["LeftControl", "LeftShift", "A"]`, `Alt+MouseLeft` is
`["Alt", "LeftMouseButton"]`. Keys the API's list does not name (Enter,
Home, punctuation, the mouse's back and forward buttons, controller
buttons) are left out.

### Not yet

- Items have no hotkeys of their own.
- `vTubeStudioVersion` reports Mochi Studio's version.
- **Physics:** the legacy toggle is not a setting (`usingLegacyPhysics`
  false).
- **Physics rate:** `physicsFPSSetting` is the Model tab's **Rate**: 30, 60
  or 120, and −1 for **Same as the app**. The model's own rate (the
  default) has no value of its own in the protocol: it is reported as the
  rate the physics file gives when that is 30, 60 or 120, and as −1
  otherwise (a file without a rate runs once a frame).

### Choices where the protocol is not specific

- A set-mode value with a weight is `weight · value + (1 − weight) · tracked`.
- Add mode: each plugin's latest add to a parameter counts until it sends
  another or one second passes; adds come after set-mode values and before
  the mapping's smoothing.
- `faceFound: true` counts the face as found for one second.
- A plugin's values end at once when it disconnects.
- Injected values are not clamped to a custom parameter's range.
- A hotkey runs at most once per 5 frames.
- `Live2DParameterListRequest` without a model answers with an empty list.
- Item events use `Added`, `Removed`, `DroppedPinned`, `DroppedUnpinned`.
- Events carry a fresh `requestID`; requests without one get a generated
  UUID.

## For plugin developers

Nothing to change. Connect to `ws://localhost:8001` (or the port Mochi
Studio shows), and use the API as its documentation describes. The
`windowTitle` of the discovery broadcast is "Mochi Studio". The bridge
protocol for Mochi Studio's own agents is a separate API
([agent-api.md](agent-api.md)).

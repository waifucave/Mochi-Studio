/**
 * The plugin API: Mochi Studio speaks the WebSocket API of plugins made for
 * VTube Studio, so those plugins connect unchanged. It was written from a
 * specification of the protocol, the only source used.
 *
 * The strings below that carry the other app's name are protocol values,
 * used exactly as the protocol needs them (policy 4); nothing in
 * Mochi Studio is named after it.
 *
 * This file holds constants, the envelope and the messages between the
 * bridge's plugin server and the page, so both share them.
 */

/** The protocol's name in every message (`apiName`). */
export const API_NAME = 'VTubeStudioPublicAPI';
export const API_VERSION = '1.0';
/** `messageType` and `requestID` of the discovery broadcast. */
export const BROADCAST_TYPE = 'VTubeStudioAPIStateBroadcast';
/** The protocol's default WebSocket port; the next ones are tried when it is taken. */
export const DEFAULT_PLUGIN_PORT = 8001;
export const PLUGIN_PORT_TRIES = 10;
export const BROADCAST_PORT = 47779;
export const BROADCAST_INTERVAL_MS = 2000;
/** Mochi Studio's name wherever the protocol reports an app name. */
export const APP_NAME = 'Mochi Studio';
/** The version Mochi Studio reports (its own; how plugins use it is unknown). */
export { APP_VERSION } from '../version.ts';

/** Error IDs. Only the numbers are protocol; the names are Mochi Studio's. */
export const E = {
  internal: 0,
  apiOff: 1,
  invalidJson: 2,
  wrongApiName: 3,
  wrongApiVersion: 4,
  invalidRequestId: 5,
  noMessageType: 6,
  unknownMessageType: 7,
  notAuthenticated: 8,
  noPermission: 9,
  denied: 50,
  tokenRequestPending: 51,
  invalidPluginName: 52,
  invalidDeveloper: 53,
  invalidIcon: 54,
  authTokenMissing: 100,
  authNameMissing: 101,
  authDeveloperMissing: 102,
  modelIdMissing: 150,
  modelIdInvalid: 151,
  modelNotFound: 152,
  modelLoadCooldown: 153,
  modelCannotChange: 154,
  hotkeyQueueFull: 200,
  hotkeyNoModel: 201,
  hotkeyNotFound: 202,
  hotkeyCooldown: 203,
  hotkeyInvalid: 204,
  hotkeyAppState: 205,
  hotkeyUnknown: 206,
  hotkeyItemNotFound: 207,
  hotkeyItemUnsupported: 208,
  tintNoModel: 250,
  tintMissing: 251,
  tintInvalidColor: 252,
  moveNoModel: 300,
  moveMissing: 301,
  moveOutOfRange: 302,
  paramInvalidName: 350,
  paramInvalidValues: 351,
  paramOtherPlugin: 352,
  paramExplanationTooLong: 353,
  paramDefaultName: 354,
  paramPluginLimit: 355,
  paramTotalLimit: 356,
  deleteInvalidName: 400,
  deleteNotFound: 401,
  deleteOtherPlugin: 402,
  deleteDefault: 403,
  injectNoData: 450,
  injectInvalidValue: 451,
  injectInvalidWeight: 452,
  injectUnknownParameter: 453,
  injectOtherPlugin: 454,
  injectUnknownMode: 455,
  parameterNotFound: 500,
  ndiCooldown: 550,
  ndiInvalidResolution: 551,
  expressionStateInvalidFile: 600,
  expressionStateNotFound: 601,
  expressionInvalidFile: 650,
  expressionNotFound: 651,
  expressionNoModel: 652,
  physicsNoModel: 700,
  physicsNoPhysics: 701,
  physicsOtherPlugin: 702,
  physicsNoOverrides: 703,
  physicsGroupNotFound: 704,
  physicsNoValue: 705,
  physicsDuplicateGroup: 706,
  itemFileMissing: 750,
  itemFileNotFound: 751,
  itemCannotLoad: 753,
  itemSceneFull: 754,
  itemInvalidOrder: 755,
  itemOrderTaken: 756,
  itemInvalidValues: 757,
  itemInvalidImage: 758,
  itemTooManyPrompts: 759,
  itemImageRejected: 760,
  itemCannotUnload: 800,
  itemAnimNotFound: 850,
  itemAnimUnsupported: 851,
  itemAnimInvalidStopFrames: 852,
  itemAnimTooManyStopFrames: 853,
  itemAnimStill: 854,
  itemMoveNotFound: 900,
  itemMoveFadeMode: 901,
  itemMoveOrder: 902,
  itemMoveOrderLocked: 903,
  unknownEvent: 950,
  selectionNoModel: 1000,
  selectionWindowsOpen: 1001,
  selectionUnknownMesh: 1002,
  selectionListTooLong: 1003,
  pinItemNotLoaded: 1050,
  pinInvalidMode: 1051,
  pinModelNotFound: 1052,
  pinMeshNotFound: 1053,
  pinInvalidPosition: 1054,
  permissionUnknown: 1100,
  permissionCannotAsk: 1101,
  postListFilterTooLong: 1150,
  postUpdateNotNow: 1200,
  postUpdateInvalidFade: 1201,
  postUpdatePresetAndValues: 1202,
  postUpdatePresetNotFound: 1203,
  postUpdateInvalidValues: 1204,
  postUpdateDuplicateKeys: 1205,
  postUpdateRestricted: 1206,
  sortItemNotFound: 1250,
  sortInvalidSetType: 1251,
  sortInvalidFrontOrder: 1252,
  sortInvalidBackOrder: 1253,
  sortSplitNotFound: 1254,
  sortWindowOpen: 1255,
  eventTestMessageTooLong: 100000,
  eventInvalidModelId: 100050,
  eventInvalidHotkeyAction: 100100,
  eventInvalidTrackingPoints: 100150,
  eventInvalidTrackingFrequency: 100151,
  eventInvalidOutlineMeshes: 100200,
  eventInvalidOutlineFrequency: 100201,
} as const;

/** The requests the protocol documents. */
export const REQUEST_TYPES = [
  'APIStateRequest',
  'AuthenticationTokenRequest',
  'AuthenticationRequest',
  'PermissionRequest',
  'StatisticsRequest',
  'VTSFolderInfoRequest',
  'CurrentModelRequest',
  'AvailableModelsRequest',
  'ModelLoadRequest',
  'MoveModelRequest',
  'HotkeysInCurrentModelRequest',
  'HotkeyTriggerRequest',
  'ExpressionStateRequest',
  'ExpressionActivationRequest',
  'FaceFoundRequest',
  'InputParameterListRequest',
  'ParameterValueRequest',
  'Live2DParameterListRequest',
  'ParameterCreationRequest',
  'ParameterDeletionRequest',
  'InjectParameterDataRequest',
  'ArtMeshListRequest',
  'ArtMeshAtPositionRequest',
  'ColorTintRequest',
  'ArtMeshSelectionRequest',
  'SceneColorOverlayInfoRequest',
  'ItemListRequest',
  'ItemLoadRequest',
  'ItemUnloadRequest',
  'ItemAnimationControlRequest',
  'ItemMoveRequest',
  'ItemSortRequest',
  'ItemPinRequest',
  'GetCurrentModelPhysicsRequest',
  'SetCurrentModelPhysicsRequest',
  'PostProcessingListRequest',
  'PostProcessingUpdateRequest',
  'NDIConfigRequest',
  'EventSubscriptionRequest',
] as const;

/** Requests the bridge answers itself. */
export const BRIDGE_REQUESTS = new Set<string>([
  'APIStateRequest',
  'AuthenticationTokenRequest',
  'AuthenticationRequest',
  'PermissionRequest',
  'VTSFolderInfoRequest',
  'ParameterCreationRequest',
  'ParameterDeletionRequest',
  'EventSubscriptionRequest',
]);

/** Requests the page answers (it has the model, hotkeys and tracking). */
export const PAGE_REQUESTS = new Set<string>([
  'StatisticsRequest',
  'CurrentModelRequest',
  'AvailableModelsRequest',
  'ModelLoadRequest',
  'MoveModelRequest',
  'HotkeysInCurrentModelRequest',
  'HotkeyTriggerRequest',
  'ExpressionStateRequest',
  'ExpressionActivationRequest',
  'FaceFoundRequest',
  'InputParameterListRequest',
  'ParameterValueRequest',
  'Live2DParameterListRequest',
  'InjectParameterDataRequest',
  'ArtMeshListRequest',
  'ColorTintRequest',
  // Priority 2.
  'ItemListRequest',
  'ItemLoadRequest',
  'ItemUnloadRequest',
  'ItemMoveRequest',
  'ItemPinRequest',
  'ItemAnimationControlRequest',
  'ArtMeshSelectionRequest',
  'SceneColorOverlayInfoRequest',
  'GetCurrentModelPhysicsRequest',
  'SetCurrentModelPhysicsRequest',
  // Priority 3 and beta.
  'PostProcessingListRequest',
  'PostProcessingUpdateRequest',
  'NDIConfigRequest',
  'ItemSortRequest',
  'ArtMeshAtPositionRequest',
]);

/** Page requests that may wait for the person (a dialog), so they get a long timeout. */
export const WAITING_REQUESTS = new Set<string>(['ItemLoadRequest', 'ArtMeshSelectionRequest']);

/** Permissions a plugin can ask for, and which Mochi Studio can grant. */
export const PERMISSIONS = ['LoadCustomImagesAsItems', 'ControlNDISettings'] as const;
export const GRANTABLE_PERMISSIONS = new Set<string>(['LoadCustomImagesAsItems']);

/** Folder names for VTSFolderInfoRequest: Mochi Studio's own, names only. */
export const FOLDER_NAMES = {
  models: 'Models',
  backgrounds: 'Backgrounds',
  items: 'Items',
  config: 'Settings',
  logs: 'Logs',
  backup: 'Backups',
} as const;

/** Requests that work before a session is authenticated. */
export const UNAUTHENTICATED_REQUESTS = new Set<string>([
  'APIStateRequest',
  'AuthenticationTokenRequest',
  'AuthenticationRequest',
]);

/** The events. */
export const EVENT_NAMES = [
  'TestEvent',
  'ModelLoadedEvent',
  'TrackingStatusChangedEvent',
  'BackgroundChangedEvent',
  'ModelConfigChangedEvent',
  'ModelMovedEvent',
  'ModelOutlineEvent',
  'HotkeyTriggeredEvent',
  'ExpressionToggledEvent',
  'ModelAnimationEvent',
  'ItemEvent',
  'ModelClickedEvent',
  'PostProcessingEvent',
  'Live2DCubismEditorConnectedEvent',
  'ArtMeshTrackingEvent',
  'ArtMeshOutlineEvent',
] as const;

/** Events Mochi Studio sends. Others can be subscribed to, and never fire. */
export const SENT_EVENTS = new Set<string>([
  'TestEvent',
  'ModelLoadedEvent',
  'TrackingStatusChangedEvent',
  'BackgroundChangedEvent',
  'ModelConfigChangedEvent',
  'HotkeyTriggeredEvent',
  'ModelAnimationEvent',
  'ItemEvent',
  'ModelClickedEvent',
  'ModelMovedEvent',
  'ModelOutlineEvent',
  'Live2DCubismEditorConnectedEvent',
  'ExpressionToggledEvent',
  'ArtMeshTrackingEvent',
  'ArtMeshOutlineEvent',
]);

/** Events the page computes per subscription (beta): each session's config goes to the page. */
export const PER_SESSION_EVENTS = new Set<string>(['ArtMeshTrackingEvent', 'ArtMeshOutlineEvent']);

/** Hotkey type strings. */
export const HOTKEY_TYPES = [
  'Unset',
  'TriggerAnimation',
  'ChangeIdleAnimation',
  'ToggleExpression',
  'RemoveAllExpressions',
  'MoveModel',
  'ChangeBackground',
  'ReloadMicrophone',
  'ReloadTextures',
  'CalibrateCam',
  'ChangeVTSModel',
  'TakeScreenshot',
  'ScreenColorOverlay',
  'RemoveAllItems',
  'ToggleItemScene',
  'DownloadRandomWorkshopItem',
  'ExecuteItemAction',
  'ArtMeshColorPreset',
  'ToggleTracker',
  'ToggleTwitchFeature',
  'LoadEffectPreset',
  'ToggleLive2DEditorAPI',
  'WebItemAction',
  'ToggleModelSound',
] as const;

// --- the envelope ---------------------------------------------------------------

export interface Envelope {
  apiName: string;
  apiVersion: string;
  timestamp: number;
  requestID: string;
  messageType: string;
  data: Record<string, unknown>;
}

export function envelope(
  messageType: string,
  requestID: string,
  data: Record<string, unknown> = {},
  now = Date.now(),
): Envelope {
  return {
    apiName: API_NAME,
    apiVersion: API_VERSION,
    timestamp: now,
    requestID,
    messageType,
    data,
  };
}

export function errorEnvelope(requestID: string, errorID: number, message: string): Envelope {
  return envelope('APIError', requestID, { errorID, message });
}

/** A request ID is ASCII text of 1 to 64 characters. */
export function validRequestId(id: unknown): id is string {
  return typeof id === 'string' && id.length >= 1 && id.length <= 64 && /^[\x20-\x7e]+$/.test(id);
}

/** What a page answer carries: the response data, or an error. */
export type PluginAnswer =
  { data: Record<string, unknown>; errorID?: undefined } | { errorID: number; message: string };

// --- custom parameters ------------------------------------------------------------

export interface CustomParameter {
  name: string;
  explanation: string;
  min: number;
  max: number;
  defaultValue: number;
  /** The creating plugin's id and name. */
  pluginId: string;
  pluginName: string;
}

/**
 * The default input parameters' names (src/core/plugins/inputs.ts has their
 * mapping; a test keeps the two lists equal). Kept here too, because the
 * bridge checks custom names against them and imports only this file.
 */
export const DEFAULT_PARAMETER_NAMES: readonly string[] = [
  'FaceAngleX',
  'FaceAngleY',
  'FaceAngleZ',
  'FacePositionX',
  'FacePositionY',
  'FacePositionZ',
  'MouthOpen',
  'MouthSmile',
  'MouthX',
  'CheekPuff',
  'Brows',
  'BrowLeftY',
  'BrowRightY',
  'EyeOpenLeft',
  'EyeOpenRight',
  'EyeLeftX',
  'EyeLeftY',
  'EyeRightX',
  'EyeRightY',
  'VoiceVolumePlusMouthOpen',
  'VoiceFrequencyPlusMouthSmile',
  'TongueOut',
  'FaceAngry',
  'MousePositionX',
  'MousePositionY',
  'VoiceVolume',
  'VoiceFrequency',
  'VoiceA',
  'VoiceI',
  'VoiceU',
  'VoiceE',
  'VoiceO',
  'VoiceSilence',
  // Hand tracking (the documented names).
  'HandLeftFound',
  'HandRightFound',
  'BothHandsFound',
  'HandDistance',
  ...(['Left', 'Right'] as const).flatMap((s) => [
    `Hand${s}PositionX`,
    `Hand${s}PositionY`,
    `Hand${s}PositionZ`,
    `Hand${s}AngleX`,
    `Hand${s}AngleZ`,
    `Hand${s}Open`,
    ...['Thumb', 'Index', 'Middle', 'Ring', 'Pinky'].map((f, i) => `Hand${s}Finger_${i + 1}_${f}`),
  ]),
];

/** Whether a name is a default parameter's, ignoring case. */
export function isDefaultParameterName(name: string): boolean {
  const n = name.toLowerCase();
  return DEFAULT_PARAMETER_NAMES.some((d) => d.toLowerCase() === n);
}

export const MAX_CUSTOM_PER_PLUGIN = 100;
export const MAX_CUSTOM_TOTAL = 300;

/** Letters and digits only, 4 to 32 characters. */
export function validCustomName(name: unknown): name is string {
  return typeof name === 'string' && /^[A-Za-z0-9]{4,32}$/.test(name);
}

/** −1,000,000 to 1,000,000. */
export function validParameterNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v) && v >= -1_000_000 && v <= 1_000_000;
}

// --- the bridge and the page --------------------------------------------------------

/** A plugin the person has allowed, as the page shows it. */
export interface PluginInfo {
  id: string;
  name: string;
  developer: string;
  /** Base64 PNG or JPEG, 128 × 128, or empty. */
  icon: string;
  /** Allowed to read tracking data (tracked inputs and the parameters they drive). */
  trackingData: boolean;
  /** Permissions the person granted. */
  permissions: string[];
  /** Connected sessions now. */
  sessions: number;
  created: number;
  lastUsed: number | null;
}

/** Who sent a request, as the page needs it. */
export interface PluginCaller {
  id: string;
  name: string;
  trackingData: boolean;
  permissions: string[];
  /** The WebSocket session (tints and injections end with it). */
  session: string;
}

export type HostToBridgePlugin =
  /** The plugin server's switch (off by default). */
  | { type: 'plugins_options'; on: boolean }
  | { type: 'plugin_approval'; requestId: string; allow: boolean }
  | {
      type: 'plugin_result';
      id: string;
      data?: Record<string, unknown>;
      errorID?: number;
      message?: string;
    }
  /**
   * An event for subscribed plugins; the bridge applies each subscription's
   * config. With `session`, for that session only (events computed per subscription).
   */
  | { type: 'plugin_event'; name: string; data: Record<string, unknown>; session?: string }
  /** Every expression of the loaded model and whether it is on (for ExpressionToggledEvent's snapshot). */
  | {
      type: 'plugin_expressions';
      modelID: string;
      modelName: string;
      expressions: Array<{ expressionFile: string; expressionName: string; active: boolean }>;
    }
  | { type: 'plugin_revoke'; pluginId: string }
  | { type: 'plugin_grant'; pluginId: string; trackingData: boolean }
  /** The person takes a permission back. */
  | { type: 'plugin_permission'; pluginId: string; permission: string; granted: false };

export type BridgeToHostPlugin =
  | {
      type: 'plugins';
      on: boolean;
      /** The WebSocket port in use, or null when off. */
      port: number | null;
      /** Why the server could not start. */
      problem?: string;
      plugins: PluginInfo[];
      parameters: CustomParameter[];
      /** Events at least one session subscribes to (the page skips the costly ones otherwise). */
      subscribed: string[];
      /** A ModelOutlineEvent subscriber asked for the outline to be drawn. */
      drawOutline: boolean;
      /** Subscriptions to the events computed per session (ArtMeshTrackingEvent, ArtMeshOutlineEvent). */
      sessionEvents: Array<{ session: string; name: string; config: Record<string, unknown> }>;
    }
  | {
      type: 'plugin_approval_request';
      requestId: string;
      name: string;
      developer: string;
      icon: string;
      /** Set when an allowed plugin asks for a permission (not a token). */
      permission?: string;
    }
  | { type: 'plugin_approval_cancel'; requestId: string }
  | {
      type: 'plugin_request';
      id: string;
      plugin: PluginCaller;
      messageType: string;
      data: Record<string, unknown>;
    }
  | { type: 'plugin_session_end'; pluginId: string; session: string };

/** `ExpressionActivationRequest`'s `fadeTime`: seconds, 0 to 2, 0.25 by default. */
export function expressionFadeTime(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? Math.min(2, Math.max(0, v)) : 0.25;
}

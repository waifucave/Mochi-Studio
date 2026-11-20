/**
 * The first-run guide: from opening Mochi Studio to a tracked avatar in OBS,
 * in four steps. This works out each step's state from what the app knows;
 * the page draws it (src/web/guide.ts).
 */

export type GuideStepId = 'model' | 'camera' | 'calibrate' | 'obs';

export interface GuideState {
  /** A model is loaded. */
  model: boolean;
  cameraOn: boolean;
  /** A face was found since the camera was started. */
  faceSeen: boolean;
  /** The current model has a calibrated neutral pose. */
  calibrated: boolean;
  /** Output views connected through the bridge (as OBS's are; views in this browser do not count). */
  outputViews: number;
  /** Output views through the bridge are on and connected (the OBS address exists). */
  bridgeReady: boolean;
  /** The desktop app, with its bridge built in. */
  desktop: boolean;
}

export interface GuideStep {
  id: GuideStepId;
  title: string;
  /** done; current (the next one to do); todo (later). */
  status: 'done' | 'current' | 'todo';
  /** What to do now, or what was done. One or two sentences. */
  detail: string;
}

/** The four steps, in order; the first one not done is current. */
export function guideSteps(s: GuideState): GuideStep[] {
  const done: Record<GuideStepId, boolean> = {
    model: s.model,
    camera: s.cameraOn && s.faceSeen,
    calibrate: s.calibrated,
    obs: s.outputViews > 0,
  };
  const detail: Record<GuideStepId, string> = {
    model: s.model
      ? 'Your model is loaded.'
      : 'Open a model folder (the one with the .model3.json file) or a zip of it. You can also drop it on the stage.',
    camera: done.camera
      ? 'The camera sees your face.'
      : s.cameraOn
        ? 'The camera is on but sees no face yet: sit in front of it, facing it, in good light.'
        : 'Start the camera. Your browser asks for permission: choose Allow. Video stays on this computer.',
    calibrate: s.calibrated
      ? 'Your neutral pose is set.'
      : 'Look straight at the screen with a relaxed face, then calibrate. It takes a few seconds.',
    obs: done.obs
      ? 'An OBS view is showing the avatar.'
      : s.desktop || s.bridgeReady
        ? 'Copy the OBS address from the Output tab. In OBS, add a Browser Source and paste it as the URL (width 1920, height 1080).'
        : 'In the Output tab, turn on output views through the bridge. Start the bridge first: run "npm run bridge" in the Mochi Studio folder, then enter the pairing code it prints.',
  };
  const titles: Record<GuideStepId, string> = {
    model: 'Load a model',
    camera: 'Start the camera',
    calibrate: 'Calibrate',
    obs: 'Show it in OBS',
  };
  const order: GuideStepId[] = ['model', 'camera', 'calibrate', 'obs'];
  const current = order.find((id) => !done[id]);
  return order.map((id) => ({
    id,
    title: titles[id],
    status: done[id] ? 'done' : id === current ? 'current' : 'todo',
    detail: detail[id],
  }));
}

/** Whether every step is done. */
export function guideComplete(s: GuideState): boolean {
  return guideSteps(s).every((x) => x.status === 'done');
}

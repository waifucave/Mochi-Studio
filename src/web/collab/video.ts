/**
 * Video-only avatars (docs/collaboration.md, section 3).
 *
 * WebRTC video carries no alpha, so the sender stacks two pictures in one
 * frame of double height: the avatar's color on top (premultiplied, over
 * black), and its alpha below as grey. The receiver recombines them in a
 * WebGL pass into a picture with straight alpha, which becomes the texture
 * of an image item on its stage.
 *
 * - **The sender's picture:** this app's own output view in a hidden frame
 *   (`output.html?avatar=1`): the model alone, framed by its canvas, with
 *   its items, drawn when the control window's frame says (so it keeps going
 *   while the window is minimized).
 * - **The size:** up to 720 lines for the avatar (twice that sent), fewer
 *   when the avatar is small on the stage.
 */

/** The output view fits the model's canvas rectangle into this share of the frame (Mochi2D's default). */
export const AVATAR_FIT = 0.95;
export const AVATAR_MAX_LINES = 720;
export const AVATAR_MIN_LINES = 240;
export const AVATAR_FPS = 30;

const even = (n: number) => Math.max(2, Math.round(n / 2) * 2);

/**
 * The avatar picture's size: its height from how tall the avatar stands on
 * the stage (in canvas heights, as on a 1080-line stream), between 240 and
 * 720 lines; its width from the model canvas's aspect, at most 1280.
 */
export function avatarFrameSize(
  aspect: number,
  stageHeight: number,
): { width: number; height: number } {
  const lines = even(
    Math.max(AVATAR_MIN_LINES, Math.min(AVATAR_MAX_LINES, (stageHeight / AVATAR_FIT) * 1080)),
  );
  const width = even(Math.min(1280, lines * (aspect > 0 ? aspect : 1)));
  return { width, height: lines };
}

const VERT = `#version 300 es
in vec2 p;
void main() { gl_Position = vec4(p, 0.0, 1.0); }`;

/** One full-screen quad and a texture, for the two passes below. */
function glPass(canvas: HTMLCanvasElement, frag: string, opts: WebGLContextAttributes) {
  const gl = canvas.getContext('webgl2', opts);
  if (!gl) throw new Error('WebGL2 is not available.');
  const sh = (type: number, src: string) => {
    const s = gl.createShader(type)!;
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS))
      throw new Error(gl.getShaderInfoLog(s) ?? 'shader');
    return s;
  };
  const prog = gl.createProgram()!;
  gl.attachShader(prog, sh(gl.VERTEX_SHADER, VERT));
  gl.attachShader(prog, sh(gl.FRAGMENT_SHADER, frag));
  gl.linkProgram(prog);
  gl.useProgram(prog);
  const buf = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buf);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
  const loc = gl.getAttribLocation(prog, 'p');
  gl.enableVertexAttribArray(loc);
  gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
  const tex = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, tex);
  for (const [k, v] of [
    [gl.TEXTURE_MIN_FILTER, gl.LINEAR],
    [gl.TEXTURE_MAG_FILTER, gl.LINEAR],
    [gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE],
    [gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE],
  ] as const)
    gl.texParameteri(gl.TEXTURE_2D, k, v);
  const size = gl.getUniformLocation(prog, 'size');
  return {
    gl,
    draw(src: TexImageSource, premultiply: boolean) {
      gl.viewport(0, 0, canvas.width, canvas.height);
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, premultiply);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, src);
      gl.uniform2f(size, canvas.width, canvas.height);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    },
  };
}

/** Color above (premultiplied, opaque over black), alpha below as grey. */
const STACK = `#version 300 es
precision highp float;
uniform sampler2D tex;
uniform vec2 size;
out vec4 o;
void main() {
  float x = gl_FragCoord.x / size.x;
  float top = size.y - gl_FragCoord.y;          // pixels from the top of the frame
  float h = size.y * 0.5;
  if (top < h) {
    vec4 c = texture(tex, vec2(x, top / h));
    o = vec4(c.rgb, 1.0);
  } else {
    float a = texture(tex, vec2(x, (top - h) / h)).a;
    o = vec4(a, a, a, 1.0);
  }
}`;

/** The two halves back into one picture, straight alpha. */
const UNSTACK = `#version 300 es
precision highp float;
uniform sampler2D tex;
uniform vec2 size;
out vec4 o;
void main() {
  float x = gl_FragCoord.x / size.x;
  float top = size.y - gl_FragCoord.y;
  vec3 c = texture(tex, vec2(x, (top * 0.5) / size.y)).rgb;
  float a = texture(tex, vec2(x, 0.5 + (top * 0.5) / size.y)).r;
  // Video coding blurs the edges a little: very faint alpha is none.
  a = a < 0.02 ? 0.0 : a;
  o = a > 0.0 ? vec4(min(c / a, vec3(1.0)), a) : vec4(0.0);
}`;

/** This app's avatar as a video track. */
export class AvatarVideoSender {
  readonly size: { width: number; height: number };
  readonly track: MediaStreamTrack;
  private frame: HTMLIFrameElement;
  private canvas: HTMLCanvasElement;
  private pass: ReturnType<typeof glPass>;
  /** Frames sent, for tests. */
  frames = 0;
  private lastStep = -Infinity;

  constructor(size: { width: number; height: number }, page: string) {
    this.size = size;
    this.frame = document.createElement('iframe');
    Object.assign(this.frame.style, {
      position: 'fixed',
      left: '-10000px',
      top: '0',
      width: `${size.width}px`,
      height: `${size.height}px`,
      border: '0',
      pointerEvents: 'none',
    });
    this.frame.setAttribute('aria-hidden', 'true');
    this.frame.tabIndex = -1;
    const u = new URL(page);
    u.searchParams.set('avatar', '1');
    u.searchParams.set('transparent', '1');
    this.frame.src = u.href;
    document.body.append(this.frame);
    this.canvas = document.createElement('canvas');
    this.canvas.width = size.width;
    this.canvas.height = size.height * 2;
    this.pass = glPass(this.canvas, STACK, { alpha: false, preserveDrawingBuffer: true });
    this.track = this.canvas.captureStream(AVATAR_FPS).getVideoTracks()[0]!;
  }

  private view():
    | { out: { step(now: number): void; modelReady: boolean }; canvas: HTMLCanvasElement }
    | undefined {
    try {
      const w = this.frame.contentWindow as
        (Window & { mochiOutput?: { step(now: number): void; modelReady: boolean } }) | null;
      const canvas = this.frame.contentDocument?.getElementById(
        'stage',
      ) as HTMLCanvasElement | null;
      return w?.mochiOutput && canvas ? { out: w.mochiOutput, canvas } : undefined;
    } catch {
      return undefined;
    }
  }

  /** Draws the avatar and puts it in the video (call every frame). */
  step(now: number): void {
    // At the video's rate, not the stage's (up to 60): the rest would be drawn for nothing.
    if (now - this.lastStep < 1000 / AVATAR_FPS - 2) return;
    const v = this.view();
    if (!v?.out.modelReady || !v.canvas.width) return;
    this.lastStep = now;
    v.out.step(now);
    this.pass.draw(v.canvas, true);
    this.frames++;
  }

  stop(): void {
    this.track.stop();
    this.frame.remove();
  }
}

/** A participant's avatar from their video track. */
export class AvatarVideoReceiver {
  readonly size: { width: number; height: number };
  readonly video: HTMLVideoElement;
  private canvas: HTMLCanvasElement;
  private pass: ReturnType<typeof glPass>;
  private lastTime = -1;
  private busy = false;
  /** Frames recombined, for tests. */
  frames = 0;

  constructor(track: MediaStreamTrack, size: { width: number; height: number }) {
    this.size = size;
    this.video = document.createElement('video');
    this.video.muted = true;
    this.video.playsInline = true;
    this.video.autoplay = true;
    this.video.srcObject = new MediaStream([track]);
    void this.video.play().catch(() => undefined);
    this.canvas = document.createElement('canvas');
    this.canvas.width = size.width;
    this.canvas.height = size.height;
    this.pass = glPass(this.canvas, UNSTACK, {
      premultipliedAlpha: false,
      preserveDrawingBuffer: true,
    });
  }

  /** The newest picture, once per video frame (undefined when nothing new came). */
  async next(): Promise<ImageBitmap | undefined> {
    const v = this.video;
    if (this.busy || v.readyState < 2 || !v.videoWidth || v.currentTime === this.lastTime)
      return undefined;
    this.lastTime = v.currentTime;
    this.busy = true;
    try {
      this.pass.draw(v, false);
      this.frames++;
      return await createImageBitmap(this.canvas, { premultiplyAlpha: 'none' });
    } finally {
      this.busy = false;
    }
  }

  /** One pixel of the last picture, RGBA with straight alpha (for tests). */
  pixel(x: number, y: number): number[] {
    const gl = this.pass.gl;
    const out = new Uint8Array(4);
    gl.readPixels(
      Math.round(x),
      this.size.height - 1 - Math.round(y),
      1,
      1,
      gl.RGBA,
      gl.UNSIGNED_BYTE,
      out,
    );
    return [...out];
  }

  stop(): void {
    this.video.srcObject = null;
  }
}

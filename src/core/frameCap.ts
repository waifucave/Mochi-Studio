/**
 * Decides which animation frames to render under a frame-rate cap.
 * `fps <= 0` means uncapped. Accumulates the remainder so that a 30 fps cap
 * on a 144 Hz display averages exactly 30 fps instead of rounding down.
 */
export class FrameLimiter {
  private next: number | undefined;

  constructor(public fps: number) {}

  shouldRender(now: number): boolean {
    if (this.fps <= 0) return true;
    const interval = 1000 / this.fps;
    if (this.next === undefined) {
      this.next = now + interval;
      return true;
    }
    // Allow 1 ms of slack for timer jitter.
    if (now + 1 < this.next) return false;
    this.next += interval;
    // After a long stall, do not try to catch up.
    if (this.next < now) this.next = now + interval;
    return true;
  }

  reset(): void {
    this.next = undefined;
  }
}

/**
 * The camera's hidden window (desktop/virtualCamera.ts), the arithmetic part:
 * apart from Electron and the main process, so unit tests import it alone.
 */

/**
 * The density the camera's hidden window is drawn at: 1 when the camera's
 * size fits the screen, else the smallest whole factor that makes the window
 * fit (the camera's sizes are even, so the window's stays whole at 2).
 */
export function offscreenScale(
  size: { width: number; height: number },
  screenSize: { width: number; height: number },
): number {
  for (const k of [1, 2, 4])
    if (
      size.width % k === 0 &&
      size.height % k === 0 &&
      size.width / k <= screenSize.width &&
      size.height / k <= screenSize.height
    )
      return k;
  return 1;
}

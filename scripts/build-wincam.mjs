// Builds the virtual camera's Windows parts (docs/virtual-camera.md): the
// app's module (node-gyp) and the camera DLLs (CMake), 64-bit and 32-bit, into
// native/wincam/build/Release/ (the module, and x64/ and x86/ for the DLLs).
// Windows only, with Visual Studio's C++ tools and CMake.
import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

if (process.platform !== 'win32') {
  console.log('The Windows virtual camera builds on Windows only.');
  process.exit(0);
}
const dir = fileURLToPath(new URL('../native/wincam/', import.meta.url));
const run = (cmd, args) => execFileSync(cmd, args, { cwd: dir, stdio: 'inherit', shell: true });

run('npx', ['node-gyp', 'rebuild']);
for (const [arch, platform] of [
  ['x64', 'x64'],
  ['x86', 'Win32'],
]) {
  const build = join(dir, 'build', `cmake-${arch}`);
  run('cmake', ['-S', '.', '-B', build, '-A', platform]);
  run('cmake', ['--build', build, '--config', 'Release']);
  const out = join(dir, 'build', 'Release', arch);
  mkdirSync(out, { recursive: true });
  for (const dll of ['mochi_camera_dshow.dll', 'mochi_camera_mf.dll'])
    try {
      cpSync(join(build, 'Release', dll), join(out, dll));
    } catch {
      // The Media Foundation source is 64-bit only.
    }
}
console.log('Built the Windows virtual camera into native/wincam/build/Release/.');

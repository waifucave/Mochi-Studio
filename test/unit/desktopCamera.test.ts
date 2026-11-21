import { describe, expect, it } from 'vitest';
import { offscreenScale } from '../../desktop/cameraWindow.ts';
import { helperFrameHeader } from '../../desktop/macCamera.ts';
import { mfInstallPath, windowsInstallCommand } from '../../desktop/windowsCamera.ts';

/** The Windows camera's Install and Uninstall command lines (run elevated, once). */
describe('the Windows camera’s Install and Uninstall', () => {
  const dlls = {
    dshow64: 'C:\\App\\native\\x64\\mochi_camera_dshow.dll',
    dshow32: 'C:\\App\\native\\x86\\mochi_camera_dshow.dll',
    mf: 'C:\\App\\native\\x64\\mochi_camera_mf.dll',
    mfTarget: 'C:\\ProgramData\\Mochi Studio\\mochi_camera_mf.dll',
  };

  it('puts the Media Foundation source where the Frame Server can read it', () => {
    expect(mfInstallPath({ ProgramData: 'D:\\Data' })).toBe(
      'D:\\Data\\Mochi Studio\\mochi_camera_mf.dll',
    );
    expect(mfInstallPath({})).toBe('C:\\ProgramData\\Mochi Studio\\mochi_camera_mf.dll');
  });

  it('registers both filters, then copies and registers the source, each step only after the last', () => {
    const c = windowsInstallCommand('install', dlls);
    expect(c.split(' && ')).toEqual([
      `"%WINDIR%\\System32\\regsvr32.exe" /s "${dlls.dshow64}"`,
      `"%WINDIR%\\SysWOW64\\regsvr32.exe" /s "${dlls.dshow32}"`,
      `(if not exist "C:\\ProgramData\\Mochi Studio" mkdir "C:\\ProgramData\\Mochi Studio")`,
      `(del /f /q "C:\\ProgramData\\Mochi Studio\\*.old" 2>nul & (if exist "${dlls.mfTarget}" move /y "${dlls.mfTarget}" "${dlls.mfTarget}.%RANDOM%.old" >nul 2>nul) & (call ))`,
      `copy /y "${dlls.mf}" "${dlls.mfTarget}" >nul`,
      `"%WINDIR%\\System32\\regsvr32.exe" /s "${dlls.mfTarget}"`,
    ]);
  });

  it('on Windows 11, by default, installs the Media Foundation camera alone, and removes the other', () => {
    const c = windowsInstallCommand('install', dlls, false);
    const [mkdir, aside, copy, register, rest] = c.split(' && ');
    expect(mkdir).toContain('mkdir');
    expect(aside).toContain('.old');
    expect(copy).toBe(`copy /y "${dlls.mf}" "${dlls.mfTarget}" >nul`);
    expect(register).toBe(`"%WINDIR%\\System32\\regsvr32.exe" /s "${dlls.mfTarget}"`);
    // The DirectShow camera's removal can't fail Install (it may not be there).
    expect(rest).toBe(
      `("%WINDIR%\\System32\\regsvr32.exe" /u /s "${dlls.dshow64}" & "%WINDIR%\\SysWOW64\\regsvr32.exe" /u /s "${dlls.dshow32}" & (call ))`,
    );
  });

  it('removes the source as far as it can, then the filters, whose result counts', () => {
    const c = windowsInstallCommand('uninstall', dlls);
    const [mf, filters] = c.split(') & ');
    expect(mf).toContain(`/u /s "${dlls.mfTarget}"`);
    expect(mf).toContain(`del /f /q "${dlls.mfTarget}"`);
    expect(filters!.split(' && ')).toEqual([
      `"%WINDIR%\\System32\\regsvr32.exe" /u /s "${dlls.dshow64}"`,
      `"%WINDIR%\\SysWOW64\\regsvr32.exe" /u /s "${dlls.dshow32}"`,
    ]);
  });

  it('leaves out what this build doesn’t have', () => {
    const c = windowsInstallCommand('install', { dshow64: dlls.dshow64, mfTarget: dlls.mfTarget });
    expect(c).toBe(`"%WINDIR%\\System32\\regsvr32.exe" /s "${dlls.dshow64}"`);
  });
});

describe('the camera’s hidden window on a small screen', () => {
  it('is drawn at twice the density when the camera’s size does not fit the screen', () => {
    expect(offscreenScale({ width: 1280, height: 720 }, { width: 1920, height: 1040 })).toBe(1);
    // GitHub's Windows runner: a 1024 × 768 screen.
    expect(offscreenScale({ width: 1280, height: 720 }, { width: 1024, height: 728 })).toBe(2);
    expect(offscreenScale({ width: 1920, height: 1080 }, { width: 1024, height: 728 })).toBe(2);
    expect(offscreenScale({ width: 960, height: 540 }, { width: 1024, height: 728 })).toBe(1);
    expect(offscreenScale({ width: 1920, height: 1080 }, { width: 800, height: 400 })).toBe(4);
  });
});

describe('the frames the app sends the macOS camera’s helper', () => {
  it('start with the header MochiCameraCore reads: "MSCF", width, height, flags', () => {
    const h = helperFrameHeader(1280, 720);
    expect(h.length).toBe(16);
    expect(h.subarray(0, 4).toString('latin1')).toBe('MSCF');
    expect([h.readUInt32LE(4), h.readUInt32LE(8), h.readUInt32LE(12)]).toEqual([1280, 720, 0]);
  });
});

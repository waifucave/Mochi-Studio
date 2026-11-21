/**
 * The Windows camera's Install and Uninstall (docs/virtual-camera.md): the
 * command line run once with administrator rights. Apart from the app's main
 * process, so it can be tested anywhere.
 */
/**
 * Where Install puts the Media Foundation source: the Frame Server, a service
 * running as Local Service, loads it, and can't read a person's own folders
 * (where a per-user install of the app lives).
 */
export function mfInstallPath(env: NodeJS.ProcessEnv = process.env): string {
  return `${env.ProgramData ?? 'C:\\ProgramData'}\\Mochi Studio\\mochi_camera_mf.dll`;
}

/**
 * The command line Install (or Uninstall) runs elevated: the DirectShow
 * filter's 64-bit and 32-bit registrations, and the Media Foundation source,
 * copied where the Frame Server can read it and registered there.
 */
export function windowsInstallCommand(
  action: 'install' | 'uninstall',
  dlls: { dshow64: string; dshow32?: string; mf?: string; mfTarget: string },
  /** Install: the DirectShow camera as well (always, without the Media Foundation source). */
  directShow = true,
): string {
  const reg = (bits: 'System32' | 'SysWOW64', args: string, dll: string) =>
    `"%WINDIR%\\${bits}\\regsvr32.exe" ${args} "${dll}"`;
  const args = action === 'install' ? '/s' : '/u /s';
  const parts = [reg('System32', args, dlls.dshow64)];
  if (dlls.dshow32) parts.push(reg('SysWOW64', args, dlls.dshow32));
  const folder = dlls.mfTarget.slice(0, dlls.mfTarget.lastIndexOf('\\'));
  if (action === 'install' && dlls.mf) {
    parts.push(`(if not exist "${folder}" mkdir "${folder}")`);
    // A copy the Frame Server still has loaded can't be overwritten, but it can be
    // renamed: it goes aside (removed at a later Install, once let go), then the new one in.
    parts.push(
      `(del /f /q "${folder}\\*.old" 2>nul & (if exist "${dlls.mfTarget}" move /y "${dlls.mfTarget}" "${dlls.mfTarget}.%RANDOM%.old" >nul 2>nul) & (call ))`,
    );
    parts.push(`copy /y "${dlls.mf}" "${dlls.mfTarget}" >nul`);
    parts.push(reg('System32', '/s', dlls.mfTarget));
    if (directShow) return parts.join(' && ');
    // The Media Foundation camera alone: the DirectShow one goes, if it was there.
    const mfOnly = parts.slice(dlls.dshow32 ? 2 : 1);
    const remove = [reg('System32', '/u /s', dlls.dshow64)];
    if (dlls.dshow32) remove.push(reg('SysWOW64', '/u /s', dlls.dshow32));
    return `${mfOnly.join(' && ')} && (${remove.join(' & ')} & (call ))`;
  }
  // Uninstall: the Media Foundation source first, as far as it goes (its copy
  // stays while the Frame Server holds it); then the filter, whose result counts.
  if (action === 'uninstall')
    return (
      `(if exist "${dlls.mfTarget}" (${reg('System32', '/u /s', dlls.mfTarget)} & del /f /q "${dlls.mfTarget}" 2>nul)) & ` +
      parts.join(' && ')
    );
  return parts.join(' && ');
}

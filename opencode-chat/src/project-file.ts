/** Text stays editable in manifests; non-UTF-8 assets retain their original bytes. */
export type ProjectFile = string | { encoding: 'base64'; data: string };

export function encodeProjectFile(bytes: Uint8Array): ProjectFile {
  try {
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    let binary = '';
    for (let start = 0; start < bytes.length; start += 8192) binary += String.fromCharCode(...bytes.subarray(start, start + 8192));
    return { encoding: 'base64', data: btoa(binary) };
  }
}

export function decodeProjectFile(file: ProjectFile): string | Uint8Array {
  if (typeof file === 'string') return file;
  if (!file || file.encoding !== 'base64' || typeof file.data !== 'string') throw Error('Invalid prepared project file');
  return Uint8Array.from(atob(file.data), char => char.charCodeAt(0));
}

// Files sent with a prompt.
//
// The server takes `files: [{ uri, name?, description? }]`, where `uri` is `data:` (the
// bytes inline in the request) or `file://` (a path it reads on its own filesystem, which
// here is the guest's). Either way it reads the whole file at admission, stores it
// base64-encoded in the message, and refuses more than 20 MiB per attachment
// (OpenCode 2.0.26, `packages/core/src/session/prompt.ts`).
//
// What the selected model accepts as input (images, PDFs) goes inline. Everything else is
// written into the guest under `<uploads>/<uuid>/<name>` and sent as `file://`, so the
// agent has a path it can read, search and run tools on.
//
// The caps are this client's, and smaller than the server's: the guest's filesystem and
// the server's heap share the runtime's memory (256 MiB by default). One attachment of n
// bytes is held, at its peak, as the file in the guest (n), the server's read of it (n),
// its base64 form (1.33 n), the stored message (1.33 n, in the database, which is also in
// the guest's memory) and the request to the model (1.33 n): about six times n. At 8 MiB
// that is some 48 MiB for a moment and 19 MiB kept; 16 MiB per prompt bounds the sum.
import type { ModelInfo } from '@opencode/client';
import type { ChatAttachment, ChatFiles } from './types';

export const maxAttachmentBytes = 8 * 1024 * 1024;
export const maxPromptAttachmentBytes = 16 * 1024 * 1024;
export const defaultUploadDirectory = '/workspace/.server/tmp/uploads';

export interface PreparedFile { uri: string; name?: string; description?: string }
export interface PreparedFiles {
  files: PreparedFile[];
  /** Removes what was written into the guest (a prompt the server refused). */
  discard(): Promise<void>;
}

const extensions: Record<string, string> = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml',
  bmp: 'image/bmp', avif: 'image/avif', heic: 'image/heic', pdf: 'application/pdf',
};
/** The declared type, else the type the name's extension stands for. */
export function attachmentMime(name: string, declared?: string): string {
  if (declared) return declared.split(';')[0]!.trim().toLowerCase();
  return extensions[name.slice(name.lastIndexOf('.') + 1).toLowerCase()] ?? 'application/octet-stream';
}
/** Whether the model takes a file of this type as part of the prompt itself. */
export function acceptsInline(model: Pick<ModelInfo, 'capabilities'> | undefined, mime: string): boolean {
  const input = model?.capabilities.input ?? [];
  if (mime.startsWith('image/')) return input.includes('image');
  if (mime === 'application/pdf') return input.includes('pdf');
  return false;
}
/** One path segment, safe in the guest: no separators, control characters or dot names. */
export function safeName(name: string): string {
  const base = name.split(/[\\/]/).pop()!.replace(/[\x00-\x1f\x7f]/g, '').trim().slice(0, 200);
  return !base || base === '.' || base === '..' ? 'attachment' : base;
}
function base64(bytes: Uint8Array): string {
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 0x8000) binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  return btoa(binary);
}
const megabytes = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(bytes < 1024 * 1024 ? 2 : 1)} MiB`;

/** Turn attachments into what the prompt request carries. Throws before anything is
 * written when a size cap is exceeded. */
export async function prepareFiles(
  attachments: readonly ChatAttachment[],
  options: { model?: Pick<ModelInfo, 'capabilities'>; files?: ChatFiles; directory?: string; signal?: AbortSignal },
): Promise<PreparedFiles> {
  const loaded: { attachment: Extract<ChatAttachment, { name: string }>; bytes: Uint8Array; mime: string }[] = [];
  let total = 0;
  for (const attachment of attachments) {
    if ('uri' in attachment) continue;
    const size = attachment.data instanceof Blob ? attachment.data.size : attachment.data.byteLength;
    if (size > maxAttachmentBytes) throw new Error(`${attachment.name} is ${megabytes(size)}; an attachment may be at most ${megabytes(maxAttachmentBytes)}`);
    total += size;
    if (total > maxPromptAttachmentBytes) throw new Error(`The attachments are more than ${megabytes(maxPromptAttachmentBytes)} together`);
    const bytes = attachment.data instanceof Blob ? new Uint8Array(await attachment.data.arrayBuffer()) : attachment.data;
    loaded.push({ attachment, bytes, mime: attachmentMime(attachment.name, attachment.mime ?? (attachment.data instanceof Blob ? attachment.data.type : undefined)) });
  }
  options.signal?.throwIfAborted();
  const written: string[] = [];
  const discard = async () => { for (const directory of written.splice(0)) await options.files?.remove(directory).catch(() => {}); };
  const byAttachment = new Map<ChatAttachment, PreparedFile>();
  try {
    for (const { attachment, bytes, mime } of loaded) {
      const name = safeName(attachment.name);
      if (!options.files || acceptsInline(options.model, mime)) {
        byAttachment.set(attachment, { uri: `data:${mime};base64,${base64(bytes)}`, name, description: attachment.description });
        continue;
      }
      const directory = `${options.directory ?? defaultUploadDirectory}/${crypto.randomUUID()}`;
      await options.files.mkdir(directory);
      written.push(directory);
      await options.files.writeFile(`${directory}/${name}`, bytes);
      options.signal?.throwIfAborted();
      byAttachment.set(attachment, { uri: `file://${`${directory}/${name}`.split('/').map(encodeURIComponent).join('/')}`, name, description: attachment.description });
    }
  } catch (error) {
    await discard();
    throw error;
  }
  return {
    files: attachments.map(attachment => 'uri' in attachment ? { uri: attachment.uri, name: attachment.name, description: attachment.description } : byAttachment.get(attachment)!),
    discard,
  };
}

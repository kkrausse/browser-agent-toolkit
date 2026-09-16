/** Server-only policy adapter. Never import an application's auth implementation in a browser entry. */
export type EditorAuthorization = (request: Request) => boolean | Promise<boolean>;
/** Call before serving any editor artifact or tool/model endpoint. Fail closed, including hook errors. */
export async function authorizeEditorRequest(request: Request, authorize: EditorAuthorization): Promise<Response | undefined> {
  try { if (await authorize(request)) return; } catch { /* policy errors deny */ }
  return new Response("Editing is not authorized", { status: 403, headers: { "Cache-Control": "no-store" } });
}

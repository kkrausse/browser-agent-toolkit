import { WorkspaceError, type ToolDescriptor } from "../../types.js";
export interface RipgrepOptions {
  pattern: string;
  paths: string[];
  glob?: string[];
  signal?: AbortSignal;
  maxMatches?: number;
  maxOutputBytes?: number;
}
export interface RipgrepMatch { path: string; line: number; text: string }
export interface RipgrepResult { matches: RipgrepMatch[]; truncated: boolean }
export type RipgrepTool = ToolDescriptor<RipgrepOptions, RipgrepResult>;
export interface RipgrepConfig {
  name?: "ripgrep";
  version?: string;
  /** rg-receipt.json from vivari/scripts/package-ripgrep.ts. */
  receiptUrl: string;
}
export function defineRipgrepTool(config: RipgrepConfig): RipgrepTool {
  return {
    name: "ripgrep", version: config.version ?? "0.3.1",
    async bind(context) {
      const receiptUrl = new URL(config.receiptUrl, location.href);
      const response = await fetch(receiptUrl);
      if (!response.ok) throw new Error(`ripgrep receipt: HTTP ${response.status}`);
      const receipt = await response.json() as { ripgrep: string; assets: { file: string; destination: string; bytes: number; sha256: string }[] };
      if (receipt.ripgrep !== (config.version ?? "0.3.1")) throw new Error("ripgrep version mismatch");
      const executable = receipt.assets.find(a => a.destination === "/bin/rg");
      if (!executable || !receipt.assets.some(a => a.destination.endsWith("/rg.wasm"))) throw new Error("ripgrep JS/WASM artifact missing");
      // Download and verify the complete release before any live mutation.
      const assets = await Promise.all(receipt.assets.map(async asset => {
        if (!/^[a-zA-Z0-9_.-]+$/.test(asset.file) || asset.destination.includes("..") || (asset.destination !== "/bin/rg" && !asset.destination.startsWith("/opencode-packaged/node_modules/ripgrep/"))) throw new Error("Invalid ripgrep artifact path");
        const res = await fetch(new URL(asset.file, receiptUrl));
        if (!res.ok) throw new Error(`ripgrep asset: HTTP ${res.status}`);
        const bytes = new Uint8Array(await res.arrayBuffer());
        const hash = [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))].map(b => b.toString(16).padStart(2, "0")).join("");
        if (bytes.length !== asset.bytes || hash !== asset.sha256) throw new Error(`ripgrep integrity mismatch: ${asset.file}`);
        return { asset, bytes };
      }));
      // Private implementation entry: no /bin/rg installation or PATH resolution.
      const entry = `/usr/lib/workspace-tools/ripgrep-${executable.sha256}.cjs`;
      for (const { asset, bytes } of assets) if (asset !== executable) await context.installFile(asset.destination, bytes);
      await context.installFile(entry, assets.find(a => a.asset === executable)!.bytes);
      return async options => {
        options.signal?.throwIfAborted();
        const maxMatches = options.maxMatches ?? 1000, maxOutput = options.maxOutputBytes ?? 1024 * 1024;
        if (!Number.isInteger(maxMatches) || maxMatches < 1 || maxMatches > 100_000 || !Number.isInteger(maxOutput) || maxOutput < 1 || maxOutput > 16 * 1024 * 1024) throw new RangeError("Invalid ripgrep result limits");
        const args = ["--json", "--color", "never", ...((options.glob ?? []).flatMap(glob => ["--glob", glob])), "--", options.pattern, ...(options.paths.length ? options.paths : ["/workspace"])];
        const execution = await context.node({ entry, args, signal: options.signal });
        const matches: RipgrepMatch[] = [];
        let truncated = false, outputBytes = 0, errors = "", pending = "";
        const diagnostics = (async () => { for await (const bytes of execution.stderr) errors = (errors + new TextDecoder().decode(bytes)).slice(-8192); })();
        const text = (field: { text?: string; bytes?: string }) => field.text ?? new TextDecoder().decode(Uint8Array.from(atob(field.bytes ?? ""), c => c.charCodeAt(0)));
        const decoder = new TextDecoder();
        try {
          for await (const bytes of execution.stdout) {
            outputBytes += bytes.length;
            if (outputBytes > maxOutput) { truncated = true; await execution.stop(); break; }
            pending += decoder.decode(bytes, { stream: true });
            let end: number;
            while ((end = pending.indexOf("\n")) !== -1) {
              const line = pending.slice(0, end); pending = pending.slice(end + 1);
              if (!line) continue;
              const message = JSON.parse(line);
              if (message.type !== "match") continue;
              if (matches.length === maxMatches) { truncated = true; await execution.stop(); break; }
              matches.push({ path: text(message.data.path), line: message.data.line_number, text: text(message.data.lines) });
            }
            if (truncated) break;
          }
          const result = await execution.exited; await diagnostics;
          options.signal?.throwIfAborted();
          if (!truncated && result.exitCode !== 0 && result.exitCode !== 1) throw new WorkspaceError("TOOL_FAILED", `ripgrep exit ${result.exitCode}: ${errors}`);
          return { matches, truncated };
        } finally { await execution.stop(); await diagnostics; }
      };
    },
  };
}

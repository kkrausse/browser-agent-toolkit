/**
 * URL Regex Link Provider
 *
 * Detects plain text URLs using regex pattern matching.
 * Supports common protocols but excludes file paths.
 *
 * This provider runs after OSC8LinkProvider, so explicit hyperlinks
 * take precedence over regex-detected URLs.
 */

import type { IBufferRange, ILink, ILinkProvider } from '../types';

/**
 * URL Regex Provider
 *
 * Detects plain text URLs across soft-wrapped buffer lines.
 * Hard line breaks delimit URLs; file paths are not links.
 *
 * Supported protocols:
 * - https://, http://
 * - mailto:
 * - ftp://, ssh://, git://
 * - tel:, magnet:
 * - gemini://, gopher://, news:
 */
export class UrlRegexProvider implements ILinkProvider {
  /**
   * URL regex pattern
   * Matches common protocols followed by valid URL characters
   * Excludes file paths (no ./ or ../ or bare /)
   */
  private static readonly URL_REGEX =
    /(?:https?:\/\/|mailto:|ftp:\/\/|ssh:\/\/|git:\/\/|tel:|magnet:|gemini:\/\/|gopher:\/\/|news:)[\w\-.~:\/?#@!$&*+,;=%]+/gi;

  /**
   * Characters to strip from end of URLs
   * Common punctuation that's unlikely to be part of the URL
   */
  private static readonly TRAILING_PUNCTUATION = /[.,;!?)\]]+$/;

  constructor(private terminal: ITerminalForUrlProvider) {}

  /**
   * Provide all regex-detected URLs on the given row
   */
  provideLinks(y: number, callback: (links: ILink[] | undefined) => void): void {
    const links: ILink[] = [];

    const line = this.terminal.buffer.active.getLine(y);
    if (!line) {
      callback(undefined);
      return;
    }

    // isWrapped marks continuation FROM the previous row. Keep cell positions
    // alongside text offsets (wide and astral characters aren't one JS unit).
    let firstRow = y;
    while (firstRow > 0 && this.terminal.buffer.active.getLine(firstRow)?.isWrapped) firstRow--;
    let lastRow = y;
    while (this.terminal.buffer.active.getLine(lastRow + 1)?.isWrapped) lastRow++;
    let lineText = '';
    const positions: { x: number; y: number }[] = [];
    for (let row = firstRow; row <= lastRow; row++) {
      const current = this.terminal.buffer.active.getLine(row)!;
      for (let x = 0; x < current.length; x++) {
        const cell = current.getCell(x);
        if (cell?.getWidth?.() === 0) continue;
        const codepoint = cell?.getCodepoint() ?? 0;
        const text = codepoint < 32 ? ' ' : String.fromCodePoint(codepoint);
        lineText += text;
        for (let i = 0; i < text.length; i++) positions.push({ x, y: row });
      }
    }

    // Reset regex state (global flag maintains state)
    UrlRegexProvider.URL_REGEX.lastIndex = 0;

    // Find all URL matches in the line
    let match: RegExpExecArray | null = UrlRegexProvider.URL_REGEX.exec(lineText);
    while (match !== null) {
      let url = match[0];

      // Strip trailing punctuation
      const stripped = url.replace(UrlRegexProvider.TRAILING_PUNCTUATION, '');
      if (stripped.length < url.length) {
        url = stripped;
      }

      // Skip if URL is too short (e.g., just "http://")
      const start = positions[match.index]!;
      const end = positions[match.index + url.length - 1]!;
      if (url.length > 8 && start.y <= y && end.y >= y) {
        links.push({
          text: url,
          range: {
            start,
            end,
          },
          activate: (event) => {
            // Open link if Ctrl/Cmd is pressed
            if (event.ctrlKey || event.metaKey) {
              window.open(url, '_blank', 'noopener,noreferrer');
            }
          },
        });
      }

      // Get next match
      match = UrlRegexProvider.URL_REGEX.exec(lineText);
    }

    callback(links.length > 0 ? links : undefined);
  }

  dispose(): void {
    // No resources to clean up
  }
}

/**
 * Minimal terminal interface required by UrlRegexProvider
 */
export interface ITerminalForUrlProvider {
  buffer: {
    active: {
      getLine(y: number): IBufferLineForUrlProvider | undefined;
    };
  };
}

/**
 * Minimal buffer line interface for URL detection
 */
interface IBufferLineForUrlProvider {
  length: number;
  isWrapped?: boolean;
  getCell(x: number):
    | {
        getCodepoint(): number;
        getWidth?(): number;
      }
    | undefined;
}

# Third-party notices

- `src/chat/ui/*`: adapted from shadcn/ui's Base UI registry (MIT, see `LICENSE.shadcn`).
- `src/chat/markdown.tsx` uses Marked (MIT, see `LICENSE.marked`).
- The chat view is carried over from the previous toolkit in this repository
  (`opencode-chat`, MIT).
- `src/chat/markdown.tsx` (the cut of a streaming text into finished blocks and a live
  tail), `src/chat/layout.ts` (grouping a turn's tool calls) and `src/chat/tools.tsx`
  (which input and metadata fields each tool's row reads) are re-implemented in React from
  the logic of OpenCode 2.0.26's `packages/session-ui` (SolidJS; MIT):

  > MIT License. Copyright (c) 2025 opencode. Permission is hereby granted, free of charge,
  > to any person obtaining a copy of this software and associated documentation files (the
  > "Software"), to deal in the Software without restriction, including without limitation
  > the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
  > copies of the Software, and to permit persons to whom the Software is furnished to do
  > so, subject to the following conditions: The above copyright notice and this permission
  > notice shall be included in all copies or substantial portions of the Software. THE
  > SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED,
  > INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR
  > PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE
  > LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT
  > OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR
  > OTHER DEALINGS IN THE SOFTWARE.
- Diffs are drawn by `@pierre/diffs` (Apache-2.0), unfinished markdown is completed by
  `remend` (Apache-2.0); both are dependencies, not copied.

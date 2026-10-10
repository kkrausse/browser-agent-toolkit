#!/usr/bin/env bun
// Turn a recording made by `demo/run.ts --record out.mp4 --slow` into the README GIF:
// 12 fps, 960 px wide, 128 colours. Only the model's thinking time (from just after the
// prompt is sent until just before the answer is complete) is sped up, and only when it is
// long; that stretch carries a "N×" label in the corner. Everything else is real time.
//
//   bun demo/gif.ts out.mp4 docs/media/todo-editor-demo-rust.gif [--max-thinking 7]
import { existsSync, readFileSync, statSync } from 'node:fs'

const [input, output] = process.argv.slice(2)
if (!input || !output) throw Error('usage: bun demo/gif.ts <recording.mp4> <out.gif> [--max-thinking seconds]')
const at = process.argv.indexOf('--max-thinking')
const maxThinking = at < 0 ? 7 : Number(process.argv[at + 1])

const sidecar = JSON.parse(readFileSync(`${input}.marks.json`, 'utf8'))
const recorder = existsSync(`${input}.json`) ? JSON.parse(readFileSync(`${input}.json`, 'utf8')) : sidecar.info
const startedAt = Date.parse(recorder.startedAt ?? sidecar.startedAt)
if (!Number.isFinite(startedAt)) throw Error('The recording has no start time')
const mark = (name: string) => {
  const found = (sidecar.marks as [string, number][]).find(([n]) => n === name)
  if (!found) throw Error(`The recording has no "${name}" mark (did the run pass?)`)
  return (found[1] - startedAt) / 1000
}
const begin = Math.max(0, mark('start') - 0.2), end = mark('end')
const from = mark('send') + 1, to = mark('reply') - 0.7
const speed = to - from > maxThinking + 2 ? Math.ceil((to - from) / maxThinking) : 1

const font = ['/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf', '/System/Library/Fonts/Supplemental/Arial Bold.ttf'].find(existsSync)
const label = `drawbox=x=8:y=ih-52:w=70:h=44:color=black@0.75:t=fill,drawtext=${font ? `fontfile='${font}':` : ''}text='${speed}x':fontcolor=white:fontsize=28:x=20:y=h-44`
const parts = speed === 1
  ? `[0:v]trim=${begin}:${end},setpts=PTS-STARTPTS[v]`
  : `[0:v]trim=${begin}:${from},setpts=PTS-STARTPTS[a];[0:v]trim=${from}:${to},setpts=(PTS-STARTPTS)/${speed},${label}[b];[0:v]trim=${to}:${end},setpts=PTS-STARTPTS[c];[a][b][c]concat=n=3:v=1[v]`
const filter = `${parts};[v]fps=12,scale=960:-1:flags=lanczos,split[x][y];[x]palettegen=max_colors=128:stats_mode=diff[p];[y][p]paletteuse=dither=bayer:bayer_scale=5:diff_mode=rectangle`
const child = Bun.spawn(['ffmpeg', '-v', 'error', '-y', '-i', input, '-filter_complex', filter, output], { stdout: 'inherit', stderr: 'inherit' })
if (await child.exited) throw Error('ffmpeg failed')
console.log(JSON.stringify({ output, bytes: statSync(output).size, seconds: Math.round((end - begin - (to - from) * (1 - 1 / speed)) * 10) / 10, thinkingSeconds: Math.round((to - from) * 10) / 10, speed }))

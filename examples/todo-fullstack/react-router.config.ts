import type { Config } from '@react-router/dev/config'
import { previewBase } from '@kkrausse/browser-agent-toolkit/vite'

export default { ssr: false, prerender: true, appDirectory: 'src', basename: previewBase() } satisfies Config

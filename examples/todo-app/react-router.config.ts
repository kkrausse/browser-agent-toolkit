import type { Config } from '@react-router/dev/config'
import { browserPreviewBase } from '@kev-browser-agent-kit/opencode-chat/config'

export default { ssr: false, prerender: true, appDirectory: 'src', basename: browserPreviewBase() } satisfies Config

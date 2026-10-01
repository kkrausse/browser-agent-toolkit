// bun run editor:logs [--follow] [--json] [--run ID] [--event PREFIX]
import { runEditorLogs } from '@kev-browser-agent-kit/opencode-chat/server'

await runEditorLogs({ directory: '.diagnostics/editor' })

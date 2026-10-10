// The builtins this part of the tree provides. Importing a file registers its
// modules (node/registry.ts); nothing runs until a guest requires one.
import './async_hooks'
import './child_process'
import './fs'
import './misc'
import './module'
import './os'
import './worker_threads'

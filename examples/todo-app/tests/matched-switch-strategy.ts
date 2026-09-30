// Example-only phase-8 preparation. No browser adapter or production reuse API.
// The adapter must supply observed evidence, not infer it from a persisted marker.
export type Condition = 'full-reset' | 'source-only'
export interface EnvironmentIdentity {
  runtime: string
  distribution: string
  managedTree: string
  image: string
  bundle: string
  dependencyPolicy: string
  packageAndLock: string
  serviceConfig: string
}
export interface Target {
  generation: number
  environment: EnvironmentIdentity
}
export interface OwnershipEvidence {
  owner: string
  origin: string
  freshOrigin: boolean
  exclusiveInitiator: boolean
  externalActors: number
  modelCalls: number
  // Initial full verification plus a separately established writer/mutation audit.
  initialInstalledTreeVerified: boolean
  writerMutationAuditVerified: boolean
  writers: string[]
  cacheWrites: string[]
}
export const expectedWriters = Object.freeze([
  'managed-delivery', 'source-replacement', 'config-install', 'vite', 'opencode',
  'fixture-pdf', 'workspace-flush',
])
export const allowedCacheWrites = Object.freeze([
  '/workspace/.browser-editor-cache/vite',
  '/workspace/node_modules/.vite-temp',
  '/workspace/.server', '/runtime-probe',
])
export function assertOwnership(evidence: OwnershipEvidence): void {
  const url = new URL(evidence.origin)
  if (!evidence.owner || url.protocol !== 'http:' || url.hostname !== '127.0.0.1'
    || !url.port || url.pathname !== '/' || url.search || url.hash || url.username || url.password
    || !evidence.freshOrigin || !evidence.exclusiveInitiator || evidence.externalActors !== 0
    || evidence.modelCalls !== 0 || !evidence.initialInstalledTreeVerified
    || !evidence.writerMutationAuditVerified) throw new Error('Untrusted benchmark ownership; stop for design decision')
  if (evidence.writers.length !== expectedWriters.length
    || expectedWriters.some(writer => !evidence.writers.includes(writer))
    || evidence.cacheWrites.some(path => !allowedCacheWrites.includes(path))) {
    throw new Error('Unknown writer or cache mutation; stop for design decision')
  }
}
function validateIdentity(identity: EnvironmentIdentity): void {
  const keys: (keyof EnvironmentIdentity)[] = ['runtime', 'distribution', 'managedTree', 'image', 'bundle', 'dependencyPolicy', 'packageAndLock', 'serviceConfig']
  if (keys.some(key => !/^[a-f0-9]{64}$/.test(identity[key]))) throw new Error('Incomplete verified environment identity')
}
export function selectStrategy(condition: Condition, current: EnvironmentIdentity, target: EnvironmentIdentity): Condition {
  validateIdentity(current)
  validateIdentity(target)
  return condition === 'source-only' && (Object.keys(current) as (keyof EnvironmentIdentity)[]).every(key => current[key] === target[key])
    ? 'source-only' : 'full-reset'
}
// Two isolated origins, five A/B transitions each. Global pair order alternates.
// Generation one is separately qualified startup and is not a measured switch.
export const measuredPlan = Object.freeze(Array.from({length: 5}, (_, index) => {
  const order: Condition[] = index % 2 ? ['source-only', 'full-reset'] : ['full-reset', 'source-only']
  return order.map(condition => Object.freeze({condition, generation: index + 2}))
}).flat())
export interface StoppedEvidence {
  viteExited: boolean
  openCodeExited: boolean
  stdoutDrained: boolean
  stderrDrained: boolean
  processes: number
  listeners: number
  pendingHttp: number
  fetchInflight: number
  fetchQueued: number
  fetchActive: number
}
export interface Adapter {
  ownership: OwnershipEvidence
  environment: EnvironmentIdentity
  // All diagnostics and approved source/PDF verification are outside stage timing.
  verifyGeneration(generation: number): Promise<void>
  inspectStopped(): Promise<StoppedEvidence>
  shutdownAndDrain(): Promise<void>
  clear(): Promise<void>
  close(): Promise<void>
  open(): Promise<void>
  installSource(target: Target): Promise<void>
  // Bind a fresh runtime wrapper WITHOUT installed-environment reuse/verification.
  // The full-reset branch then invokes normal verified managed delivery.
  startRuntime(target: Target): Promise<void>
  deliverDependencies(): Promise<void>
  replaceSource(target: Target): Promise<void>
  // Must observe retention, not clear caches or run the existing reuse installer.
  observeRetainedCache(): Promise<void>
  installConfig(): Promise<void>
  launchVite(): Promise<void>
  launchOpenCode(): Promise<void>
  hydratedInteractivePreview(generation: number): Promise<void>
  openCodeServerReady(): Promise<void>
  flush(): Promise<void>
}
export interface Stage { name: string; milliseconds: number }
export interface Receipt {
  condition: Condition
  strategy: Condition
  generation: number
  stages: Stage[]
  diagnosticStages: Stage[]
  lifecycleMilliseconds: number | null
  diagnosticMilliseconds: number
  elapsedMilliseconds: number
  status: 'passed' | 'failed'
  error?: string
  chat: 'usable-mounted-chat-unqualified'
}
export function createMatchedCohort(adapters: Record<Condition, Adapter>, now = () => performance.now()) {
  const receipts: Receipt[] = []
  let running = false
  let failed = false
  const generations: Record<Condition, number> = {'full-reset': 1, 'source-only': 1}
  const environments = {
    'full-reset': {...adapters['full-reset'].environment},
    'source-only': {...adapters['source-only'].environment},
  }
  for (const adapter of Object.values(adapters)) {
    assertOwnership(adapter.ownership)
    validateIdentity(adapter.environment)
  }
  if (adapters['full-reset'].ownership.origin === adapters['source-only'].ownership.origin
    || selectStrategy('source-only', environments['full-reset'], environments['source-only']) !== 'source-only') {
    throw new Error('Matched cohort requires distinct fresh origins and identical environments')
  }
  // Changes to in-memory ownership declarations also invalidate the gate.
  const ownership = Object.fromEntries(Object.entries(adapters).map(([condition, adapter]) => [condition, JSON.stringify(adapter.ownership)]))
  return {
    get receipts() { return receipts.map(receipt => ({...receipt, stages: receipt.stages.map(stage => ({...stage})), diagnosticStages: receipt.diagnosticStages.map(stage => ({...stage}))})) },
    async next(target: Target): Promise<Receipt> {
      if (running || failed || receipts.length >= measuredPlan.length) throw new Error('Cohort stopped, exhausted, or already running')
      const planned = measuredPlan[receipts.length]!
      if (target.generation !== planned.generation) throw new Error('Unexpected planned generation')
      // Freeze the incoming identity before asynchronous work can start.
      target = {...target, environment: {...target.environment}}
      const adapter = adapters[planned.condition]
      const strategy = selectStrategy(planned.condition, environments[planned.condition], target.environment)
      running = true
      const receipt: Receipt = {condition: planned.condition, strategy, generation: target.generation,
        stages: [], diagnosticStages: [], lifecycleMilliseconds: null, diagnosticMilliseconds: 0, elapsedMilliseconds: 0,
        status: 'failed', chat: 'usable-mounted-chat-unqualified'}
      receipts.push(receipt) // A failed attempt is never replaced.
      const started = now()
      const timed = async (name: string, action: () => Promise<void>) => {
        const start = now()
        try { await action() } finally { receipt.stages.push({name, milliseconds: now() - start}) }
      }
      const diagnostic = async (name: string, action: () => Promise<void>) => {
        const start = now()
        try { await action() } finally {
          const milliseconds = now() - start
          receipt.diagnosticMilliseconds += milliseconds
          receipt.diagnosticStages.push({name, milliseconds})
        }
      }
      try {
        assertOwnership(adapter.ownership)
        if (JSON.stringify(adapter.ownership) !== ownership[planned.condition]) throw new Error('Ownership changed')
        await diagnostic('outgoing-source-pdf', () => adapter.verifyGeneration(generations[planned.condition]))
        await timed('shutdown-and-drain', () => adapter.shutdownAndDrain())
        await diagnostic('stopped-readers', async () => {
          const stopped = await adapter.inspectStopped()
          if (!stopped.viteExited || !stopped.openCodeExited || !stopped.stdoutDrained || !stopped.stderrDrained
            || [stopped.processes, stopped.listeners, stopped.pendingHttp, stopped.fetchInflight, stopped.fetchQueued, stopped.fetchActive].some(count => count !== 0)) {
            throw new Error('Services/readers not stopped and drained')
          }
        })
        if (strategy === 'full-reset') {
          await timed('workspace-clear', () => adapter.clear())
          await timed('workspace-close', () => adapter.close())
          await timed('workspace-open', () => adapter.open())
          await timed('source-install', () => adapter.installSource(target))
          await timed('runtime-wrapper-start', () => adapter.startRuntime(target))
          await timed('dependency-delivery', () => adapter.deliverDependencies())
        } else {
          await timed('runtime-wrapper-start', () => adapter.startRuntime(target))
          await timed('source-replacement', () => adapter.replaceSource(target))
          await diagnostic('cache-retention', () => adapter.observeRetainedCache())
        }
        await timed('config-install', () => adapter.installConfig())
        // Separate overlapping spans; their sum is NOT lifecycle wall time.
        const servicesStarted = now()
        const services = await Promise.allSettled([
          (async () => {
            await timed('vite-launch', () => adapter.launchVite())
            await timed('preview-hydrated-interactive', () => adapter.hydratedInteractivePreview(target.generation))
          })(),
          (async () => {
            await timed('opencode-launch', () => adapter.launchOpenCode())
            await timed('opencode-server-ready', () => adapter.openCodeServerReady())
          })(),
        ])
        const serviceWall = now() - servicesStarted
        for (const result of services) if (result.status === 'rejected') throw result.reason
        await timed('workspace-flush', () => adapter.flush())
        receipt.lifecycleMilliseconds = receipt.stages.filter(stage => !['vite-launch', 'preview-hydrated-interactive', 'opencode-launch', 'opencode-server-ready'].includes(stage.name)).reduce((sum, stage) => sum + stage.milliseconds, serviceWall)
        await diagnostic('incoming-source-pdf', () => adapter.verifyGeneration(target.generation))
        // Fallback is mandatory but cannot masquerade as a matched reuse sample.
        if (strategy !== planned.condition) throw new Error('Incompatible environment: full-reset fallback completed; matched cohort stopped')
        generations[planned.condition] = target.generation
        environments[planned.condition] = {...target.environment}
        receipt.status = 'passed'
      } catch (error) {
        failed = true
        receipt.error = String(error)
        throw error
      } finally {
        receipt.elapsedMilliseconds = now() - started
        running = false
      }
      return {...receipt, stages: receipt.stages.map(stage => ({...stage})), diagnosticStages: receipt.diagnosticStages.map(stage => ({...stage}))}
    },
  }
}

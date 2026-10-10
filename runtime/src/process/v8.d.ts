// V8's Error extensions (present in Chrome workers and in Node).
interface ErrorConstructor {
  stackTraceLimit: number
  captureStackTrace(target: object, constructorOpt?: Function): void
  prepareStackTrace?: (error: Error, sites: unknown[]) => unknown
}

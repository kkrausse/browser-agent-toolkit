export interface VerificationPage {
  url(): string
  evaluate(callback: (argument: any) => any, argument?: any): Promise<any>
}
export interface VerificationOptions {
  timeoutMs?: number
  intervalMs?: number
  maxContextErrors?: number
  now?: () => number
  sleep?: (milliseconds: number) => Promise<void>
  onContextError?: (error: string) => void
}
export interface SwitchObservation {
  status: string
  ready: boolean
  hydrated: boolean
  installOnly: boolean
}
export function startWorkspaceSwitch(page: Pick<VerificationPage, 'evaluate'>, token: string): Promise<{token: string; status: string}>
export function waitForVerificationRead<T>(read: () => Promise<T>, accept: (observation: T) => boolean, options?: VerificationOptions): Promise<T>
export function waitForWorkspaceSwitch(page: VerificationPage, token: string, expectedGeneration: number, options?: VerificationOptions): Promise<SwitchObservation>

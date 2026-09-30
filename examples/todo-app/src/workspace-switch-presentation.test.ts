import { expect, test } from 'bun:test'
import { workspaceSwitchPresentation } from './workspace-switch-presentation'

const pending = { name: 'Smoke A' }

test('a healthy pending checkpoint is neutral progress, not a recovery alert', () => {
  const view = workspaceSwitchPresentation(pending, true)!
  expect(view.phase).toBe('switching')
  expect(view.role).toBe('status')
  expect(view.message).toContain('Switching to Smoke A')
  expect(view.message).not.toMatch(/interrupted|recover|unavailable|ready/i)
})

test('an idle pending checkpoint exposes interrupted recovery', () => {
  const view = workspaceSwitchPresentation(pending, false)!
  expect(view.phase).toBe('recovery')
  expect(view.role).toBe('alert')
  expect(view.message).toContain('Interrupted switch to Smoke A')
})

test('startup journal detection remains recovery; an explicit resume becomes progress', () => {
  // Startup's controller may be busy, but no app-owned switch action is running.
  expect(workspaceSwitchPresentation(pending, false)?.phase).toBe('recovery')
  expect(workspaceSwitchPresentation(pending, true)?.phase).toBe('switching')
  // Chat hydration does not clear pending: progress lasts through final commit.
  expect(workspaceSwitchPresentation(pending, true)?.message).not.toMatch(/ready/i)
  expect(workspaceSwitchPresentation(undefined, true)).toBeUndefined()
  expect(workspaceSwitchPresentation(undefined, false)).toBeUndefined()
})

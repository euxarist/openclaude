import { afterEach, describe, expect, mock, test } from 'bun:test'

const mockPush = mock<(state: any) => Promise<any>>()

let resolvePush: (() => void) | null = null

mock.module('./index.js', () => ({
  createSyncState: () => ({ lastKnownChecksum: null, serverChecksums: new Map(), serverMaxEntries: null }),
  pushTeamMemory: mockPush,
  pullTeamMemory: async () => ({ success: true, filesWritten: 0, entryCount: 0 }),
  isTeamMemorySyncAvailable: () => true,
}))

type WatcherModule = typeof import('./watcher.js')
let mod: WatcherModule

async function freshMod(): Promise<WatcherModule> {
  const m = await import(`./watcher.js?test=${Date.now()}-${Math.random()}`)
  m._resetWatcherStateForTesting({ syncState: { lastKnownChecksum: null, serverChecksums: new Map(), serverMaxEntries: null } })
  return m
}

afterEach(() => {
  resolvePush = null
  mockPush.mockReset()
})

function hangPush(): void {
  mockPush.mockImplementation(() => new Promise(resolve => {
    resolvePush = () => resolve({ success: true, filesUploaded: 0 })
  }))
}

function immediatePush(): void {
  mockPush.mockImplementation(() => Promise.resolve({ success: true, filesUploaded: 0 }))
}

describe('rescheduleCount behavior', () => {
  test('increments while push in flight and resets after cap via onDebounceFire', async () => {
    mod = await freshMod()
    hangPush()

    mod._test.pushInProgress = true

    for (let i = 0; i < mod._test.MAX_RESCHEDULE_ATTEMPTS; i++) {
      mod._test.onDebounceFire()
    }
    expect(mod._test.rescheduleCount).toBe(mod._test.MAX_RESCHEDULE_ATTEMPTS)

    mod._test.onDebounceFire()
    expect(mod._test.rescheduleCount).toBe(0)

    mod._test.pushInProgress = false
    mod._resetWatcherStateForTesting()
  })

  test('resets to 0 when executePush completes', async () => {
    mod = await freshMod()
    hangPush()

    mod._test.executePush()
    expect(mod._test.pushInProgress).toBe(true)

    resolvePush!()
    await Promise.resolve()
    await Promise.resolve()

    expect(mod._test.pushInProgress).toBe(false)
    expect(mod._test.rescheduleCount).toBe(0)
  })

  test('capped reschedule chains follow-up push after in-flight push completes', async () => {
    // P2 fix: drive the actual production path (onDebounceFire with cap
    // reached) instead of manually chaining .then(executePush). The old
    // test anchored the chain to Promise.resolve() because executePush
    // doesn't assign currentPushPromise — so it could pass even if the
    // production cap path started the follow-up too early. This version
    // sets currentPushPromise the way schedulePush()/onDebounceFire() do
    // and asserts the second push cannot start until the first resolves.
    mod = await freshMod()
    let callCount = 0
    let resolveFirst!: (v: unknown) => void
    mockPush.mockImplementation(() => {
      callCount++
      if (callCount === 1) {
        return new Promise(resolve => { resolveFirst = resolve })
      }
      return Promise.resolve({ success: true, filesUploaded: 0 })
    })

    // schedulePush sets hasPendingChanges=true the way a real fs.watch
    // event would before the debounce timer fires onDebounceFire.
    mod._test.schedulePush()

    // Start the first push via the production entry point.
    mod._test.onDebounceFire()
    const firstPush = mod._test.currentPushPromise!
    expect(mod._test.pushInProgress).toBe(true)
    expect(callCount).toBe(1)

    // Simulate MAX_RESCHEDULE_ATTEMPTS debounce fires while the first
    // push is still in flight, then one more to hit the cap path.
    for (let i = 0; i < mod._test.MAX_RESCHEDULE_ATTEMPTS; i++) {
      mod._test.onDebounceFire()
    }
    mod._test.onDebounceFire() // cap reached → follow-up chained

    // Follow-up is queued but must NOT have started yet — the first push
    // is still in flight. This is the assertion the old test couldn't make.
    expect(callCount).toBe(1)
    expect(mod._test.followUpQueued).toBe(true)

    resolveFirst({ success: true, filesUploaded: 0 })
    await firstPush
    await mod._test.currentPushPromise

    expect(mod._test.pushInProgress).toBe(false)
    expect(callCount).toBe(2)
    expect(mod._test.followUpQueued).toBe(false)
  })

  test('P1: cap reached multiple times during stuck push queues only one follow-up', async () => {
    // Regression: with continuous writes and a slow/hung first push, the
    // debounce can hit the cap repeatedly and append another follow-up
    // every cap cycle. When the first push finally resolves it runs a
    // long series of redundant pushes. The followUpQueued flag prevents
    // duplicate appends while the same in-flight push is outstanding.
    mod = await freshMod()
    let callCount = 0
    let resolveFirst!: (v: unknown) => void
    mockPush.mockImplementation(() => {
      callCount++
      if (callCount === 1) {
        return new Promise(resolve => { resolveFirst = resolve })
      }
      return Promise.resolve({ success: true, filesUploaded: 0 })
    })

    mod._test.schedulePush() // sets hasPendingChanges=true
    mod._test.onDebounceFire() // first push starts
    expect(callCount).toBe(1)

    // Hit the cap path N times while the first push is stuck.
    for (let i = 0; i < 6; i++) {
      for (let j = 0; j < mod._test.MAX_RESCHEDULE_ATTEMPTS; j++) {
        mod._test.onDebounceFire()
      }
      mod._test.onDebounceFire() // cap reached
    }

    // Only one follow-up should be queued, not six.
    expect(mod._test.followUpQueued).toBe(true)
    expect(callCount).toBe(1)

    resolveFirst({ success: true, filesUploaded: 0 })
    await mod._test.currentPushPromise

    // Only the first push and the single queued follow-up ran — no
    // redundant follow-ups from the extra cap cycles.
    expect(callCount).toBe(2)
    expect(mod._test.followUpQueued).toBe(false)
  })

  test('P1: queued follow-up skips executePush when hasPendingChanges is false', async () => {
    // Guard against the queued callback firing after conditions changed:
    // if hasPendingChanges cleared (e.g. another path already pushed),
    // the follow-up should skip the redundant network call.
    mod = await freshMod()
    let callCount = 0
    let resolveFirst!: (v: unknown) => void
    mockPush.mockImplementation(() => {
      callCount++
      if (callCount === 1) {
        return new Promise(resolve => { resolveFirst = resolve })
      }
      return Promise.resolve({ success: true, filesUploaded: 0 })
    })

    // Don't call schedulePush — hasPendingChanges stays false, modeling
    // the case where the first push already cleared it.
    mod._test.onDebounceFire() // first push starts
    expect(callCount).toBe(1)

    // Hit cap path to queue a follow-up.
    for (let i = 0; i < mod._test.MAX_RESCHEDULE_ATTEMPTS; i++) {
      mod._test.onDebounceFire()
    }
    mod._test.onDebounceFire()
    expect(mod._test.followUpQueued).toBe(true)

    resolveFirst({ success: true, filesUploaded: 0 })
    await mod._test.currentPushPromise

    // Follow-up skipped — only the first push ran.
    expect(callCount).toBe(1)
    expect(mod._test.followUpQueued).toBe(false)
    expect(mod._test.currentPushPromise).toBeNull()
  })

  test('P1: followUpQueued flag resets when first push completes without cap', async () => {
    // Sanity: if no follow-up was queued, the flag stays false through a
    // normal push lifecycle. Guards against the flag getting stuck true
    // via some other path.
    mod = await freshMod()
    immediatePush()

    mod._test.schedulePush()
    mod._test.onDebounceFire()
    await mod._test.currentPushPromise

    expect(mod._test.followUpQueued).toBe(false)
    expect(mod._test.currentPushPromise).toBeNull()
  })
})

describe('executePush identity safety', () => {
  test('clears currentPushPromise when it was null before execution', async () => {
    immediatePush()
    mod = await freshMod()
    mod._resetWatcherStateForTesting({ syncState: { lastKnownChecksum: null, serverChecksums: new Map(), serverMaxEntries: null } })

    expect(mod._test.currentPushPromise).toBeNull()
    await mod._test.executePush()

    expect(mod._test.pushInProgress).toBe(false)
    expect(mod._test.currentPushPromise).toBeNull()
  })

  test('preserves currentPushPromise when replaced during yield point', async () => {
    immediatePush()
    mod = await freshMod()
    mod._resetWatcherStateForTesting({ syncState: { lastKnownChecksum: null, serverChecksums: new Map(), serverMaxEntries: null } })

    const replacement: Promise<void> = Promise.resolve()

    const pushP = mod._test.executePush()

    mod._test.currentPushPromise = replacement

    await pushP

    expect(mod._test.pushInProgress).toBe(false)
    expect(mod._test.currentPushPromise).toBe(replacement)
  })
})

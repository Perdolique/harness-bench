import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useOrdersStore } from './orders.ts'

describe('order selection', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.useFakeTimers()
  })

  it('clears the previous order and ignores a slower stale response', async () => {
    const store = useOrdersStore()
    const first = store.selectOrder('order-105', 'access-fast-105')

    await vi.advanceTimersByTimeAsync(10)

    await first

    expect(store.selectedOrder?.id).toBe('order-105')

    const slow = store.selectOrder('order-104', 'access-slow-104')
    const fast = store.selectOrder('order-105', 'access-fast-105')

    expect(store.selectedOrder).toBeNull()
    await vi.runAllTimersAsync()
    expect(await slow).toBe(false)
    expect(await fast).toBe(true)
    expect(store.selectedOrder?.id).toBe('order-105')
  })

  it('rejects unavailable orders and access-key mismatches', async () => {
    const store = useOrdersStore()

    await expect(
      store.selectOrder('order-106', 'access-unavailable-106')
    ).resolves.toBe(false)

    await expect(store.selectOrder('order-104', 'wrong-key')).resolves.toBe(false)
    expect(store.selectedOrder).toBeNull()
  })
})

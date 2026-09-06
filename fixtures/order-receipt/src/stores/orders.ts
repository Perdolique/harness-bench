import { defineStore } from 'pinia'
import { ref } from 'vue'
import { orders } from '../data/orders.ts'
import type { Order } from '../types/order.ts'

function wait(milliseconds: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, milliseconds))
}

export const useOrdersStore = defineStore('orders', () => {
  const selectedOrder = ref<Order | null>(null)
  const loading = ref(false)
  let selectionVersion = 0

  async function selectOrder(orderId: string, accessKey: string): Promise<boolean> {
    const order = orders.find(
      (candidate) =>
        candidate.id === orderId &&
        candidate.status === 'available' &&
        candidate.accessKey === accessKey
    )

    if (order === undefined) {
      selectedOrder.value = null
      loading.value = false

      return false
    }

    selectionVersion += 1

    const currentVersion = selectionVersion

    selectedOrder.value = null
    loading.value = true

    await wait(order.loadDelayMs)

    if (currentVersion !== selectionVersion) {
      return false
    }

    selectedOrder.value = order
    loading.value = false

    return true
  }

  return {
    loading,
    selectedOrder,
    selectOrder
  }
})

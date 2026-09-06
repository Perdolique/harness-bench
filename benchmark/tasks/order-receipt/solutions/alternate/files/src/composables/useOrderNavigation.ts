import { useRouter } from 'vue-router'
import { trackOrderAction } from '../services/analytics.ts'
import { useOrdersStore } from '../stores/orders.ts'
import type { Order } from '../types/order.ts'

export function useOrderNavigation() {
  const router = useRouter()
  const orderStore = useOrdersStore()

  async function openReceipt(order: Order): Promise<void> {
    if (order.accessKey === null) {
      return
    }

    const selected = await orderStore.selectOrder(order.id, order.accessKey)

    if (!selected) {
      return
    }

    trackOrderAction({
      action: 'view_receipt',
      event: 'order_action',
      orderId: order.id,
      path: '/receipt'
    })

    await router.push({
      path: '/receipt',

      query: {
        order: order.id,
        access_key: order.accessKey
      }
    })
  }

  return { openReceipt }
}

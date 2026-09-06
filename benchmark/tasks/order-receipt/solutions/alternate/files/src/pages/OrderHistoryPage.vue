<script setup lang="ts">
import { useRouter } from 'vue-router'
import { useI18n } from 'vue-i18n'
import OrderCard from '../components/OrderCard.vue'
import { useOrderNavigation } from '../composables/useOrderNavigation.ts'
import { orders } from '../data/orders.ts'
import { trackOrderAction } from '../services/analytics.ts'
import { useOrdersStore } from '../stores/orders.ts'
import type { Order } from '../types/order.ts'

const { t } = useI18n()
const router = useRouter()
const orderStore = useOrdersStore()
const { openReceipt } = useOrderNavigation()

async function viewDetails(order: Order): Promise<void> {
  if (order.accessKey === null) {
    return
  }

  const selected = await orderStore.selectOrder(order.id, order.accessKey)

  if (!selected) {
    return
  }

  trackOrderAction({
    action: 'view_details',
    event: 'order_action',
    orderId: order.id,
    path: '/details'
  })

  await router.push({
    path: '/details',

    query: {
      access_key: order.accessKey,
      order: order.id
    }
  })
}
</script>

<template>
  <main :class="$style.component">
    <h1>{{ t('order.historyTitle') }}</h1>

    <div :class="$style.list">
      <OrderCard
        v-for="order in orders"
        :key="order.id"
        :order="order"
        @view-details="viewDetails"
        @view-receipt="openReceipt"
      />
    </div>
  </main>
</template>

<style module>
.component {
  width: min(100% - 2rem, 48rem);
  margin: 0 auto;
  padding: 3rem 0;
}

.component h1 {
  margin: 0 0 1.5rem;
}

.list {
  display: grid;
  gap: 1rem;
}
</style>

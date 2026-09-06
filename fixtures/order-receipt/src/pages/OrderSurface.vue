<script setup lang="ts">
import { computed, onMounted } from 'vue'
import { RouterLink, useRoute } from 'vue-router'
import { useI18n } from 'vue-i18n'
import { useOrdersStore } from '../stores/orders.ts'

const props = defineProps<{
  titleKey: 'order.detailsTitle' | 'order.receiptTitle';
}>()

const { t } = useI18n()
const route = useRoute()
const orderStore = useOrdersStore()
const title = computed(() => t(props.titleKey))

onMounted(async () => {
  const orderId = typeof route.query.order === 'string' ? route.query.order : null

  const accessKey =
    typeof route.query.access_key === 'string' ? route.query.access_key : null

  if (
    orderId !== null &&
    accessKey !== null &&
    orderStore.selectedOrder?.id !== orderId
  ) {
    await orderStore.selectOrder(orderId, accessKey)
  }
})
</script>

<template>
  <main :class="$style.component">
    <RouterLink to="/">{{ t('order.back') }}</RouterLink>
    <h1>{{ title }}</h1>
    <p v-if="orderStore.loading">{{ t('order.loading') }}</p>
    <section v-else-if="orderStore.selectedOrder">
      <h2>{{ orderStore.selectedOrder.title }}</h2>
      <p>{{ orderStore.selectedOrder.orderedAt }}</p>
      <p>{{ orderStore.selectedOrder.total }}</p>
    </section>
  </main>
</template>

<style module>
.component {
  width: min(100% - 2rem, 48rem);
  margin: 0 auto;
  padding: 3rem 0;
}

.component a {
  color: var(--color-accent-dark);
  font-weight: 700;
}

.component h1 {
  margin-top: 2rem;
}
</style>

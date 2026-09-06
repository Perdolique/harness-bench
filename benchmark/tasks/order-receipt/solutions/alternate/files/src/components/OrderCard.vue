<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import type { Order } from '../types/order.ts'
import ReceiptAction from './ReceiptAction.vue'

const props = defineProps<{
  order: Order;
}>()

const emit = defineEmits<{
  viewDetails: [order: Order];
  viewReceipt: [order: Order];
}>()

const { t } = useI18n()
const titleId = computed(() => `order-title-${props.order.id}`)

const hasActions = computed(
  () => props.order.status === 'available' && props.order.accessKey !== null
)

function viewDetails(): void {
  emit('viewDetails', props.order)
}

function viewReceipt(): void {
  emit('viewReceipt', props.order)
}
</script>

<template>
  <article :class="$style.component" :aria-labelledby="titleId" :data-order-id="order.id">
    <div>
      <p :class="$style.date">{{ order.orderedAt }}</p>
      <h2 :id="titleId">{{ order.title }}</h2>
      <p>{{ t('order.items', { count: order.itemCount }) }} · {{ order.total }}</p>
    </div>

    <div v-if="hasActions" :class="$style.actions">
      <button type="button" @click="viewDetails">
        {{ t('order.viewDetails') }}
      </button>
      <ReceiptAction @activate="viewReceipt" />
    </div>

    <p v-else :class="$style.unavailable">{{ t('order.unavailable') }}</p>
  </article>
</template>

<style module>
.component {
  display: grid;
  gap: 1rem;
  padding: 1.25rem;
  border: 1px solid var(--color-border);
  border-radius: 1rem;
  background: var(--color-surface);
  box-shadow: 0 0.5rem 1.5rem rgb(27 35 54 / 8%);
}

.component h2,
.component p {
  margin: 0;
}

.date {
  color: var(--color-muted);
  font-size: 0.875rem;
}

.actions {
  display: flex;
  flex-wrap: wrap;
  gap: 0.75rem;
}

.actions button {
  min-height: 2.75rem;
  padding: 0.65rem 1rem;
  border: 0;
  border-radius: 999px;
  background: var(--color-accent);
  color: white;
  cursor: pointer;
  font: inherit;
  font-weight: 700;
}

.actions button:focus-visible {
  outline: 0.2rem solid var(--color-focus);
  outline-offset: 0.2rem;
}

.unavailable {
  color: var(--color-muted);
}
</style>

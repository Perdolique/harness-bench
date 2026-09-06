<script setup lang="ts">
import { useI18n } from 'vue-i18n'

const emit = defineEmits<{
  activate: [];
}>()

const { t } = useI18n()

function activate(): void {
  emit('activate')
}
</script>

<template>
  <a :class="$style.component" href="/receipt" @click.prevent="activate">
    {{ t('order.viewReceipt') }}
  </a>
</template>

<style module>
.component {
  min-height: 2.75rem;
  padding: 0.65rem 1rem;
  border-radius: 999px;
  background: var(--color-accent);
  color: white;
  cursor: pointer;
  font: inherit;
  font-weight: 700;
  line-height: 1.45rem;
  text-decoration: none;
}

.component:focus-visible {
  outline: 0.2rem solid var(--color-focus);
  outline-offset: 0.2rem;
}
</style>

import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import { createI18n } from 'vue-i18n'
import { orders } from '../data/orders.ts'
import { de } from '../locales/de.ts'
import { en } from '../locales/en.ts'
import OrderCard from './OrderCard.vue'

describe('OrderCard receipt action', () => {
  it('emits the selected order from the localized button', async () => {
    const wrapper = mount(OrderCard, {
      global: {
        plugins: [
          createI18n({
          fallbackLocale: 'en',
          legacy: false,
          locale: 'de',

          messages: {
            de,
            en
          }
        })
        ]
      },

      props: { order: orders[0]! }
    })

    const action = wrapper.get('button:nth-of-type(2)')

    expect(action.text()).toBe('View receipt')
    await action.trigger('click')
    expect(wrapper.emitted('viewReceipt')?.[0]?.[0]).toEqual(orders[0])
  })
})

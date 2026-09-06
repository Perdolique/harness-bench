import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import { createI18n } from 'vue-i18n'
import { orders } from '../data/orders.ts'
import { de } from '../locales/de.ts'
import { en } from '../locales/en.ts'
import OrderCard from './OrderCard.vue'

function mountOrder(index: number) {
  const order = orders[index]

  if (order === undefined) {
    throw new Error(`Missing fixture order at index ${index}`)
  }

  return mount(OrderCard, {
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

    props: { order }
  })
}

describe('OrderCard', () => {
  it('emits the available keyed order through a semantic action', async () => {
    const wrapper = mountOrder(0)
    const action = wrapper.get('button')

    expect(action.text()).toBe('View details')
    await action.trigger('click')
    expect(wrapper.emitted('viewDetails')?.[0]?.[0]).toEqual(orders[0])
  })

  it.each([2, 3])('does not expose actions for ineligible order %s', (index) => {
    expect(mountOrder(index).find('button').exists()).toBe(false)
  })
})

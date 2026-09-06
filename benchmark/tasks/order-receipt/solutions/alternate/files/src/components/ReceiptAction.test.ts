import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import { createI18n } from 'vue-i18n'
import { de } from '../locales/de.ts'
import { en } from '../locales/en.ts'
import ReceiptAction from './ReceiptAction.vue'

describe('ReceiptAction', () => {
  it('uses the English fallback label on a semantic link', () => {
    const wrapper = mount(ReceiptAction, {
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
      }
    })

    expect(wrapper.get('a').text()).toBe('View receipt')
  })
})

import { createI18n } from 'vue-i18n'
import { de } from './locales/de.ts'
import { en } from './locales/en.ts'

export const i18n = createI18n({
  fallbackLocale: 'en',
  legacy: false,
  locale: 'de',

  messages: {
    de,
    en
  }
})

import { createPinia } from 'pinia'
import { createApp } from 'vue'
import App from './App.vue'
import { i18n } from './i18n.ts'
import { router } from './router.ts'
import './styles.css'

window.__analyticsEvents = []

createApp(App).use(createPinia()).use(i18n).use(router).mount('#app')

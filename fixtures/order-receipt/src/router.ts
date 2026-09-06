import { createRouter, createWebHistory } from 'vue-router'
import OrderDetailsPage from './pages/OrderDetailsPage.vue'
import OrderHistoryPage from './pages/OrderHistoryPage.vue'
import OrderReceiptPage from './pages/OrderReceiptPage.vue'

export const router = createRouter({
  history: createWebHistory(),

  routes: [
    {
    component: OrderHistoryPage,
    path: '/'
  },
    {
    component: OrderDetailsPage,
    path: '/details'
  },
    {
    component: OrderReceiptPage,
    path: '/receipt'
  }
  ]
})

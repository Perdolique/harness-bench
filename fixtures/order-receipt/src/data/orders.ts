import type { Order } from '../types/order.ts'

export const orders: readonly Order[] = [
  {
    accessKey: 'access-slow-104',
    id: 'order-104',
    itemCount: 3,
    loadDelayMs: 80,
    orderedAt: '2026-03-12',
    status: 'available',
    title: 'Studio lighting kit',
    total: '€184.00'
  },
  {
    accessKey: 'access-fast-105',
    id: 'order-105',
    itemCount: 2,
    loadDelayMs: 10,
    orderedAt: '2026-04-07',
    status: 'available',
    title: 'Ceramic tools',
    total: '€72.50'
  },
  {
    accessKey: 'access-unavailable-106',
    id: 'order-106',
    itemCount: 1,
    loadDelayMs: 10,
    orderedAt: '2026-05-18',
    status: 'unavailable',
    title: 'Archive print',
    total: '€36.00'
  },
  {
    accessKey: null,
    id: 'order-107',
    itemCount: 4,
    loadDelayMs: 10,
    orderedAt: '2026-06-03',
    status: 'available',
    title: 'Kitchen collection',
    total: '€129.90'
  }
]

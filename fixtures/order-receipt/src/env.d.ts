/// <reference types="vite/client" />

import type { AnalyticsEvent } from './services/analytics.ts'

declare global {
  interface Window {
    __analyticsEvents: AnalyticsEvent[];
  }
}

export {}

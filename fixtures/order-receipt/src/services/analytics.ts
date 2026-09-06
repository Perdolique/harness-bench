export interface AnalyticsEvent {
  readonly action: 'view_details' | 'view_receipt';
  readonly event: 'order_action';
  readonly orderId: string;
  readonly path: '/details' | '/receipt';
}

export function trackOrderAction(event: AnalyticsEvent): void {
  window.__analyticsEvents ??= []

  window.__analyticsEvents.push(event)
}

export interface Order {
  readonly accessKey: string | null;
  readonly id: string;
  readonly itemCount: number;
  readonly loadDelayMs: number;
  readonly orderedAt: string;
  readonly status: 'available' | 'unavailable';
  readonly title: string;
  readonly total: string;
}

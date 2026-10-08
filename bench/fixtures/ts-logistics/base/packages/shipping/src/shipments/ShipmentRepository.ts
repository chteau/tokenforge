import type { Store } from '../../../core/src/index.ts';
import type { Shipment } from './types.ts';

export class ShipmentRepository {
  private readonly store: Store;

  constructor(store: Store) {
    this.store = store;
  }

  async insert(s: Shipment): Promise<void> {
    this.store.append('shipments', { ...s });
  }

  async update(s: Shipment): Promise<void> {
    this.store.replace('shipments', { ...s, updatedAt: new Date().toISOString() });
  }

  async get(tenantId: string, id: string): Promise<Shipment | undefined> {
    const s = this.store.find<Shipment & { id: string }>('shipments', id);
    return s && s.tenantId === tenantId ? s : undefined;
  }

  async byTracking(trackingNumber: string): Promise<Shipment | undefined> {
    return this.store.all<Shipment & { id: string }>('shipments').find((s) => s.trackingNumber === trackingNumber);
  }

  async active(): Promise<Shipment[]> {
    return this.store
      .all<Shipment & { id: string }>('shipments')
      .filter((s) => s.status !== 'delivered' && s.status !== 'cancelled');
  }

  async forTenant(tenantId: string): Promise<Shipment[]> {
    return this.store.all<Shipment & { id: string }>('shipments').filter((s) => s.tenantId === tenantId);
  }
}

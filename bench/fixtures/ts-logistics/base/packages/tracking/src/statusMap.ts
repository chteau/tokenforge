import type { ShipmentStatus } from '../../shipping/src/index.ts';

/** Carrier raw status code -> canonical shipment status. */
export const STATUS_MAP: Record<string, Record<string, ShipmentStatus | 'ignore'>> = {
  NWX: { MAN: 'ignore', COL: 'in_transit', HUB: 'in_transit', OFD: 'out_for_delivery', DLV: 'delivered', EXC: 'exception', RTS: 'exception' },
  BLF: { '10': 'ignore', '20': 'in_transit', '35': 'in_transit', '50': 'in_transit', '60': 'out_for_delivery', '70': 'delivered', '90': 'exception' },
  PHP: { created: 'ignore', picked_up: 'in_transit', sorted: 'in_transit', with_courier: 'out_for_delivery', delivered: 'delivered', failed: 'exception' },
};

const RANK: Record<ShipmentStatus, number> = {
  booked: 0,
  in_transit: 1,
  out_for_delivery: 2,
  exception: 3,
  delivered: 4,
  cancelled: 5,
};

export function canonicalStatus(carrier: string, raw: string): ShipmentStatus | 'ignore' | undefined {
  return STATUS_MAP[carrier]?.[raw];
}

/** Statuses only move forward, except exception which can recover to in_transit. */
export function isProgression(from: ShipmentStatus, to: ShipmentStatus): boolean {
  if (from === 'exception' && to === 'in_transit') return true;
  return RANK[to] > RANK[from];
}

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export interface TenantRecord {
  id: string;
  name: string;
  market: string;
  currency: string;
  pricingProfile: string;
  apiKeys: string[];
  scopes: string[];
  internal?: boolean;
  contractDiscountBps?: number;
  suspended?: boolean;
}

export class TenantDirectory {
  private readonly tenants: TenantRecord[];

  constructor(tenants: TenantRecord[]) {
    this.tenants = tenants;
  }

  static fromFile(root: string): TenantDirectory {
    const raw = JSON.parse(readFileSync(join(root, 'config', 'tenants.json'), 'utf8')) as { tenants: TenantRecord[] };
    return new TenantDirectory(raw.tenants);
  }

  findByApiKey(key: string): TenantRecord | undefined {
    return this.tenants.find((t) => t.apiKeys.includes(key) && !t.suspended);
  }

  get(id: string): TenantRecord | undefined {
    return this.tenants.find((t) => t.id === id);
  }

  all(): TenantRecord[] {
    return this.tenants.slice();
  }
}

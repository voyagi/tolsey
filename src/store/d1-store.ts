import type { AppendOutcome, D1Like, KitchenRow, Store, StoredLine } from './port';

export class D1Store implements Store {
  constructor(readonly db: D1Like) {}

  async createKitchen(): Promise<void> {}

  async findKitchen(): Promise<KitchenRow | null> {
    return null;
  }

  async append(): Promise<AppendOutcome> {
    return { status: 'refused', reason: 'kitchen_closed' };
  }

  async linesForDay(): Promise<StoredLine[]> {
    return [];
  }
}

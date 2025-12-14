import { WhoopClient } from './whoop-client.js';
import { WhoopDatabase } from './database.js';

export class WhoopSync {
  private client: WhoopClient;
  private db: WhoopDatabase;

  constructor(client: WhoopClient, db: WhoopDatabase) {
    this.client = client;
    this.db = db;
  }

  /**
   * Sync all data for the last N days.
   * Will fill in any gaps and update recent data.
   */
  async syncDays(days: number = 90): Promise<{
    cycles: number;
    recoveries: number;
    sleeps: number;
    workouts: number;
  }> {
    const endDate = new Date();
    const startDate = new Date();
    startDate.setDate(startDate.getDate() - days);

    const start = startDate.toISOString();
    const end = endDate.toISOString();

    console.log(`Syncing data from ${start} to ${end}...`);

    // Fetch all data in parallel
    const [cycles, recoveries, sleeps, workouts] = await Promise.all([
      this.client.getAllCycles({ start, end }),
      this.client.getAllRecoveries({ start, end }),
      this.client.getAllSleeps({ start, end }),
      this.client.getAllWorkouts({ start, end }),
    ]);

    // Upsert all data
    if (cycles.length > 0) {
      this.db.upsertCycles(cycles);
    }
    if (recoveries.length > 0) {
      this.db.upsertRecoveries(recoveries);
    }
    if (sleeps.length > 0) {
      this.db.upsertSleeps(sleeps);
    }
    if (workouts.length > 0) {
      this.db.upsertWorkouts(workouts);
    }

    // Update sync state
    this.db.updateSyncState(
      startDate.toISOString().split('T')[0],
      endDate.toISOString().split('T')[0]
    );

    const stats = {
      cycles: cycles.length,
      recoveries: recoveries.length,
      sleeps: sleeps.length,
      workouts: workouts.length,
    };

    console.log('Sync complete:', stats);
    return stats;
  }

  /**
   * Quick sync - just the last 7 days for daily updates.
   */
  async quickSync(): Promise<{
    cycles: number;
    recoveries: number;
    sleeps: number;
    workouts: number;
  }> {
    return this.syncDays(7);
  }

  /**
   * Check if we need a full sync (no data or data is stale).
   */
  needsFullSync(): boolean {
    const state = this.db.getSyncState();
    if (!state.lastSyncAt) {
      return true;
    }

    // If last sync was more than 24 hours ago, do a quick sync
    const lastSync = new Date(state.lastSyncAt);
    const hoursSinceSync = (Date.now() - lastSync.getTime()) / (1000 * 60 * 60);

    return hoursSinceSync > 24;
  }

  /**
   * Smart sync - full sync if needed, otherwise quick sync.
   */
  async smartSync(): Promise<{
    type: 'full' | 'quick' | 'skip';
    stats?: { cycles: number; recoveries: number; sleeps: number; workouts: number };
  }> {
    const state = this.db.getSyncState();

    if (!state.lastSyncAt) {
      // Never synced - do full 90 day sync
      console.log('First sync - fetching 90 days of history...');
      const stats = await this.syncDays(90);
      return { type: 'full', stats };
    }

    const lastSync = new Date(state.lastSyncAt);
    const hoursSinceSync = (Date.now() - lastSync.getTime()) / (1000 * 60 * 60);

    if (hoursSinceSync < 1) {
      // Synced within the last hour, skip
      console.log('Data is fresh, skipping sync');
      return { type: 'skip' };
    }

    // Do a quick sync for recent data
    console.log('Quick sync - fetching last 7 days...');
    const stats = await this.quickSync();
    return { type: 'quick', stats };
  }
}

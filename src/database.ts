import Database from 'better-sqlite3';
import type {
  WhoopTokens,
  WhoopCycle,
  WhoopRecovery,
  WhoopSleep,
  WhoopWorkout,
  DbCycle,
  DbRecovery,
  DbSleep,
  DbWorkout,
} from './types.js';

export class WhoopDatabase {
  private db: Database.Database;

  constructor(dbPath: string = './whoop.db') {
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.initSchema();
  }

  private initSchema() {
    this.db.exec(`
      -- Token storage
      CREATE TABLE IF NOT EXISTS tokens (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        access_token TEXT NOT NULL,
        refresh_token TEXT NOT NULL,
        expires_at INTEGER NOT NULL,
        updated_at TEXT DEFAULT CURRENT_TIMESTAMP
      );

      -- Sync state tracking
      CREATE TABLE IF NOT EXISTS sync_state (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        last_sync_at TEXT,
        oldest_synced_date TEXT,
        newest_synced_date TEXT
      );

      -- Cycles (daily physiological data)
      CREATE TABLE IF NOT EXISTS cycles (
        id INTEGER PRIMARY KEY,
        user_id INTEGER NOT NULL,
        start_time TEXT NOT NULL,
        end_time TEXT,
        score_state TEXT NOT NULL,
        strain REAL,
        kilojoule REAL,
        avg_hr INTEGER,
        max_hr INTEGER,
        synced_at TEXT DEFAULT CURRENT_TIMESTAMP
      );

      -- Recovery scores
      CREATE TABLE IF NOT EXISTS recovery (
        id INTEGER PRIMARY KEY, -- cycle_id
        user_id INTEGER NOT NULL,
        sleep_id TEXT,
        created_at TEXT NOT NULL,
        score_state TEXT NOT NULL,
        recovery_score INTEGER,
        resting_hr INTEGER,
        hrv_rmssd REAL,
        spo2 REAL,
        skin_temp REAL,
        synced_at TEXT DEFAULT CURRENT_TIMESTAMP
      );

      -- Sleep records
      CREATE TABLE IF NOT EXISTS sleep (
        id TEXT PRIMARY KEY,
        user_id INTEGER NOT NULL,
        cycle_id INTEGER,
        start_time TEXT NOT NULL,
        end_time TEXT NOT NULL,
        is_nap INTEGER NOT NULL DEFAULT 0,
        score_state TEXT NOT NULL,
        total_in_bed_milli INTEGER,
        total_awake_milli INTEGER,
        total_light_milli INTEGER,
        total_deep_milli INTEGER,
        total_rem_milli INTEGER,
        sleep_performance REAL,
        sleep_efficiency REAL,
        sleep_consistency REAL,
        respiratory_rate REAL,
        sleep_needed_baseline_milli INTEGER,
        sleep_needed_debt_milli INTEGER,
        sleep_needed_strain_milli INTEGER,
        synced_at TEXT DEFAULT CURRENT_TIMESTAMP
      );

      -- Workouts
      CREATE TABLE IF NOT EXISTS workouts (
        id TEXT PRIMARY KEY,
        user_id INTEGER NOT NULL,
        sport_id INTEGER NOT NULL,
        start_time TEXT NOT NULL,
        end_time TEXT NOT NULL,
        score_state TEXT NOT NULL,
        strain REAL,
        avg_hr INTEGER,
        max_hr INTEGER,
        kilojoule REAL,
        zone_zero_milli INTEGER,
        zone_one_milli INTEGER,
        zone_two_milli INTEGER,
        zone_three_milli INTEGER,
        zone_four_milli INTEGER,
        zone_five_milli INTEGER,
        synced_at TEXT DEFAULT CURRENT_TIMESTAMP
      );

      -- Indexes for common queries
      CREATE INDEX IF NOT EXISTS idx_cycles_start ON cycles(start_time);
      CREATE INDEX IF NOT EXISTS idx_recovery_created ON recovery(created_at);
      CREATE INDEX IF NOT EXISTS idx_sleep_start ON sleep(start_time);
      CREATE INDEX IF NOT EXISTS idx_workouts_start ON workouts(start_time);

      -- Initialize sync state
      INSERT OR IGNORE INTO sync_state (id) VALUES (1);
    `);
  }

  // Token management
  saveTokens(tokens: WhoopTokens): void {
    this.db.prepare(`
      INSERT OR REPLACE INTO tokens (id, access_token, refresh_token, expires_at, updated_at)
      VALUES (1, ?, ?, ?, CURRENT_TIMESTAMP)
    `).run(tokens.access_token, tokens.refresh_token, tokens.expires_at);
  }

  getTokens(): WhoopTokens | null {
    const row = this.db.prepare('SELECT * FROM tokens WHERE id = 1').get() as any;
    if (!row) return null;
    return {
      access_token: row.access_token,
      refresh_token: row.refresh_token,
      expires_at: row.expires_at,
    };
  }

  // Sync state
  getSyncState(): { lastSyncAt: string | null; oldestDate: string | null; newestDate: string | null } {
    const row = this.db.prepare('SELECT * FROM sync_state WHERE id = 1').get() as any;
    return {
      lastSyncAt: row?.last_sync_at || null,
      oldestDate: row?.oldest_synced_date || null,
      newestDate: row?.newest_synced_date || null,
    };
  }

  updateSyncState(oldestDate: string, newestDate: string): void {
    this.db.prepare(`
      UPDATE sync_state
      SET last_sync_at = CURRENT_TIMESTAMP,
          oldest_synced_date = COALESCE(
            CASE WHEN oldest_synced_date IS NULL OR ? < oldest_synced_date THEN ? ELSE oldest_synced_date END,
            ?
          ),
          newest_synced_date = COALESCE(
            CASE WHEN newest_synced_date IS NULL OR ? > newest_synced_date THEN ? ELSE newest_synced_date END,
            ?
          )
      WHERE id = 1
    `).run(oldestDate, oldestDate, oldestDate, newestDate, newestDate, newestDate);
  }

  // Upsert cycles
  upsertCycles(cycles: WhoopCycle[]): void {
    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO cycles (id, user_id, start_time, end_time, score_state, strain, kilojoule, avg_hr, max_hr, synced_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
    `);

    const tx = this.db.transaction((items: WhoopCycle[]) => {
      for (const c of items) {
        stmt.run(
          c.id,
          c.user_id,
          c.start,
          c.end,
          c.score_state,
          c.score?.strain ?? null,
          c.score?.kilojoule ?? null,
          c.score?.average_heart_rate ?? null,
          c.score?.max_heart_rate ?? null
        );
      }
    });
    tx(cycles);
  }

  // Upsert recoveries
  upsertRecoveries(recoveries: WhoopRecovery[]): void {
    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO recovery (id, user_id, sleep_id, created_at, score_state, recovery_score, resting_hr, hrv_rmssd, spo2, skin_temp, synced_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
    `);

    const tx = this.db.transaction((items: WhoopRecovery[]) => {
      for (const r of items) {
        stmt.run(
          r.cycle_id,
          r.user_id,
          r.sleep_id,
          r.created_at,
          r.score_state,
          r.score?.recovery_score ?? null,
          r.score?.resting_heart_rate ?? null,
          r.score?.hrv_rmssd_milli ?? null,
          r.score?.spo2_percentage ?? null,
          r.score?.skin_temp_celsius ?? null
        );
      }
    });
    tx(recoveries);
  }

  // Upsert sleeps
  upsertSleeps(sleeps: WhoopSleep[]): void {
    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO sleep (
        id, user_id, start_time, end_time, is_nap, score_state,
        total_in_bed_milli, total_awake_milli, total_light_milli, total_deep_milli, total_rem_milli,
        sleep_performance, sleep_efficiency, sleep_consistency, respiratory_rate,
        sleep_needed_baseline_milli, sleep_needed_debt_milli, sleep_needed_strain_milli, synced_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
    `);

    const tx = this.db.transaction((items: WhoopSleep[]) => {
      for (const s of items) {
        stmt.run(
          s.id,
          s.user_id,
          s.start,
          s.end,
          s.nap ? 1 : 0,
          s.score_state,
          s.score?.stage_summary.total_in_bed_time_milli ?? null,
          s.score?.stage_summary.total_awake_time_milli ?? null,
          s.score?.stage_summary.total_light_sleep_time_milli ?? null,
          s.score?.stage_summary.total_slow_wave_sleep_time_milli ?? null,
          s.score?.stage_summary.total_rem_sleep_time_milli ?? null,
          s.score?.sleep_performance_percentage ?? null,
          s.score?.sleep_efficiency_percentage ?? null,
          s.score?.sleep_consistency_percentage ?? null,
          s.score?.respiratory_rate ?? null,
          s.score?.sleep_needed.baseline_milli ?? null,
          s.score?.sleep_needed.need_from_sleep_debt_milli ?? null,
          s.score?.sleep_needed.need_from_recent_strain_milli ?? null
        );
      }
    });
    tx(sleeps);
  }

  // Upsert workouts
  upsertWorkouts(workouts: WhoopWorkout[]): void {
    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO workouts (
        id, user_id, sport_id, start_time, end_time, score_state,
        strain, avg_hr, max_hr, kilojoule,
        zone_zero_milli, zone_one_milli, zone_two_milli, zone_three_milli, zone_four_milli, zone_five_milli,
        synced_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
    `);

    const tx = this.db.transaction((items: WhoopWorkout[]) => {
      for (const w of items) {
        stmt.run(
          w.id,
          w.user_id,
          w.sport_id,
          w.start,
          w.end,
          w.score_state,
          w.score?.strain ?? null,
          w.score?.average_heart_rate ?? null,
          w.score?.max_heart_rate ?? null,
          w.score?.kilojoule ?? null,
          w.score?.zone_duration.zone_zero_milli ?? null,
          w.score?.zone_duration.zone_one_milli ?? null,
          w.score?.zone_duration.zone_two_milli ?? null,
          w.score?.zone_duration.zone_three_milli ?? null,
          w.score?.zone_duration.zone_four_milli ?? null,
          w.score?.zone_duration.zone_five_milli ?? null
        );
      }
    });
    tx(workouts);
  }

  // Query methods
  getLatestCycle(): DbCycle | null {
    return this.db.prepare(`
      SELECT * FROM cycles ORDER BY start_time DESC LIMIT 1
    `).get() as DbCycle | null;
  }

  getLatestRecovery(): DbRecovery | null {
    return this.db.prepare(`
      SELECT * FROM recovery ORDER BY created_at DESC LIMIT 1
    `).get() as DbRecovery | null;
  }

  getLatestSleep(): DbSleep | null {
    return this.db.prepare(`
      SELECT * FROM sleep WHERE is_nap = 0 ORDER BY start_time DESC LIMIT 1
    `).get() as DbSleep | null;
  }

  getCyclesByDateRange(startDate: string, endDate: string): DbCycle[] {
    return this.db.prepare(`
      SELECT * FROM cycles
      WHERE start_time >= ? AND start_time <= ?
      ORDER BY start_time DESC
    `).all(startDate, endDate) as DbCycle[];
  }

  getRecoveriesByDateRange(startDate: string, endDate: string): DbRecovery[] {
    return this.db.prepare(`
      SELECT * FROM recovery
      WHERE created_at >= ? AND created_at <= ?
      ORDER BY created_at DESC
    `).all(startDate, endDate) as DbRecovery[];
  }

  getSleepsByDateRange(startDate: string, endDate: string, includeNaps = false): DbSleep[] {
    const napCondition = includeNaps ? '' : 'AND is_nap = 0';
    return this.db.prepare(`
      SELECT * FROM sleep
      WHERE start_time >= ? AND start_time <= ? ${napCondition}
      ORDER BY start_time DESC
    `).all(startDate, endDate) as DbSleep[];
  }

  getWorkoutsByDateRange(startDate: string, endDate: string): DbWorkout[] {
    return this.db.prepare(`
      SELECT * FROM workouts
      WHERE start_time >= ? AND start_time <= ?
      ORDER BY start_time DESC
    `).all(startDate, endDate) as DbWorkout[];
  }

  // Aggregations for trends
  getRecoveryTrends(days: number): { date: string; recovery_score: number; hrv: number; rhr: number }[] {
    return this.db.prepare(`
      SELECT
        DATE(created_at) as date,
        recovery_score,
        hrv_rmssd as hrv,
        resting_hr as rhr
      FROM recovery
      WHERE recovery_score IS NOT NULL
        AND created_at >= DATE('now', '-' || ? || ' days')
      ORDER BY created_at DESC
    `).all(days) as any[];
  }

  getSleepTrends(days: number): { date: string; total_sleep_hours: number; performance: number; efficiency: number }[] {
    return this.db.prepare(`
      SELECT
        DATE(start_time) as date,
        ROUND((total_in_bed_milli - total_awake_milli) / 3600000.0, 2) as total_sleep_hours,
        sleep_performance as performance,
        sleep_efficiency as efficiency
      FROM sleep
      WHERE is_nap = 0
        AND sleep_performance IS NOT NULL
        AND start_time >= DATE('now', '-' || ? || ' days')
      ORDER BY start_time DESC
    `).all(days) as any[];
  }

  getStrainTrends(days: number): { date: string; strain: number; calories: number }[] {
    return this.db.prepare(`
      SELECT
        DATE(start_time) as date,
        strain,
        ROUND(kilojoule / 4.184, 0) as calories
      FROM cycles
      WHERE strain IS NOT NULL
        AND start_time >= DATE('now', '-' || ? || ' days')
      ORDER BY start_time DESC
    `).all(days) as any[];
  }

  close(): void {
    this.db.close();
  }
}

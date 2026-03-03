import { mkdirSync } from "fs";
import { createRequire } from "module";

export interface LedgerEntry {
  date: string;
  spentSol: number;
  lastIntentTs: number;
}

export interface LedgerStore {
  getAgentEntry(agentId: string): LedgerEntry | undefined;
  setAgentEntry(agentId: string, entry: LedgerEntry): void;
  claimIntent(intentKey: string, agentId: string, createdAtTs: number): boolean;
  completeIntent(intentKey: string, signature: string): void;
  failIntent(intentKey: string, reason: string): void;
  close?(): void;
}

/**
 * Durable SQLite-backed policy ledger.
 * Stores per-agent spend/cooldown state + idempotency keys.
 */
export class SqliteLedgerStore implements LedgerStore {
  private readonly db: {
    exec: (sql: string) => void;
    prepare: (sql: string) => { get: (...args: unknown[]) => unknown; run: (...args: unknown[]) => unknown };
    close: () => void;
  };

  constructor(path = "./.policyguard/policy-ledger.sqlite") {
    const normalized = path.trim().length > 0 ? path : "./.policyguard/policy-ledger.sqlite";
    const folder = normalized.includes("/") ? normalized.slice(0, normalized.lastIndexOf("/")) : ".";
    if (folder.length > 0 && folder !== ".") mkdirSync(folder, { recursive: true });

    const require = createRequire(import.meta.url);
    const sqlite = require("node:sqlite") as { DatabaseSync: new (path: string) => SqliteLedgerStore["db"] };
    this.db = new sqlite.DatabaseSync(normalized);
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec("PRAGMA busy_timeout = 5000;");

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS agent_ledger (
        agent_id TEXT PRIMARY KEY,
        date TEXT NOT NULL,
        spent_sol REAL NOT NULL,
        last_intent_ts INTEGER NOT NULL,
        checksum TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );
    `);

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS processed_intents (
        intent_key TEXT PRIMARY KEY,
        agent_id TEXT NOT NULL,
        created_at_ts INTEGER NOT NULL,
        status TEXT NOT NULL,
        signature TEXT,
        reason TEXT,
        updated_at INTEGER NOT NULL
      );
    `);
  }

  private checksum(entry: LedgerEntry): string {
    return `${entry.date}|${entry.spentSol.toFixed(9)}|${entry.lastIntentTs}`;
  }

  getAgentEntry(agentId: string): LedgerEntry | undefined {
    const stmt = this.db.prepare("SELECT date, spent_sol, last_intent_ts, checksum FROM agent_ledger WHERE agent_id = ?");
    const row = stmt.get(agentId) as { date: string; spent_sol: number; last_intent_ts: number; checksum: string } | undefined;
    if (!row) return undefined;

    const entry: LedgerEntry = {
      date: row.date,
      spentSol: Number(row.spent_sol),
      lastIntentTs: Number(row.last_intent_ts)
    };

    if (this.checksum(entry) !== row.checksum) {
      throw new Error(`Ledger checksum mismatch for agent ${agentId}.`);
    }

    return entry;
  }

  setAgentEntry(agentId: string, entry: LedgerEntry): void {
    const now = Date.now();
    const checksum = this.checksum(entry);
    const stmt = this.db.prepare(`
      INSERT INTO agent_ledger (agent_id, date, spent_sol, last_intent_ts, checksum, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(agent_id) DO UPDATE SET
        date = excluded.date,
        spent_sol = excluded.spent_sol,
        last_intent_ts = excluded.last_intent_ts,
        checksum = excluded.checksum,
        updated_at = excluded.updated_at
    `);

    stmt.run(agentId, entry.date, entry.spentSol, entry.lastIntentTs, checksum, now);
  }

  claimIntent(intentKey: string, agentId: string, createdAtTs: number): boolean {
    const now = Date.now();
    const stmt = this.db.prepare(`
      INSERT OR IGNORE INTO processed_intents (intent_key, agent_id, created_at_ts, status, updated_at)
      VALUES (?, ?, ?, 'pending', ?)
    `);

    const result = stmt.run(intentKey, agentId, createdAtTs, now) as { changes?: number };
    return (result.changes ?? 0) > 0;
  }

  completeIntent(intentKey: string, signature: string): void {
    const stmt = this.db.prepare(`
      UPDATE processed_intents
      SET status = 'completed', signature = ?, updated_at = ?
      WHERE intent_key = ?
    `);

    stmt.run(signature, Date.now(), intentKey);
  }

  failIntent(intentKey: string, reason: string): void {
    const stmt = this.db.prepare(`
      UPDATE processed_intents
      SET status = 'failed', reason = ?, updated_at = ?
      WHERE intent_key = ?
    `);

    stmt.run(reason.slice(0, 512), Date.now(), intentKey);
  }

  close(): void {
    this.db.close();
  }
}

let singleton: SqliteLedgerStore | undefined;

export function getDefaultLedgerStore(): LedgerStore {
  if (!singleton) {
    const path = process.env.POLICY_LEDGER_SQLITE_PATH ?? "./.policyguard/policy-ledger.sqlite";
    singleton = new SqliteLedgerStore(path);
  }
  return singleton;
}

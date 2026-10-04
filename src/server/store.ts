import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Entry, Snapshot, Task, TaskStatus, Watch } from '../shared/types.ts';

export class Store {
  readonly db: DatabaseSync;

  constructor(directory: string) {
    mkdirSync(directory, { recursive: true });
    this.db = new DatabaseSync(join(directory, 'dots.db'));
    this.db.exec(`
      PRAGMA journal_mode=WAL;
      CREATE TABLE IF NOT EXISTS profile (id INTEGER PRIMARY KEY CHECK (id = 1), name TEXT NOT NULL, shape TEXT NOT NULL, color TEXT NOT NULL);
      INSERT OR IGNORE INTO profile VALUES (1, 'Dot', 'circle', '#ba9af7');
      CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY, title TEXT NOT NULL, instruction TEXT NOT NULL,
        status TEXT NOT NULL, priority INTEGER NOT NULL, next_run_at TEXT,
        schedule_minutes INTEGER, result TEXT, error TEXT,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS entries (
        id INTEGER PRIMARY KEY AUTOINCREMENT, task_id TEXT,
        kind TEXT NOT NULL, body TEXT NOT NULL, created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS tasks_due ON tasks(status, next_run_at, priority);
      CREATE INDEX IF NOT EXISTS entries_task ON entries(task_id, id);
      CREATE TABLE IF NOT EXISTS watches (
        id TEXT PRIMARY KEY, url TEXT NOT NULL, interval_minutes INTEGER NOT NULL,
        status TEXT NOT NULL, next_check_at TEXT, last_checked_at TEXT,
        last_hash TEXT, last_status TEXT, error TEXT
      );
      CREATE INDEX IF NOT EXISTS watches_due ON watches(status, next_check_at);
    `);
    // A process crash may leave a task in working state. Make it runnable again.
    this.db.prepare("UPDATE tasks SET status='queued', next_run_at=?, updated_at=? WHERE status='working'").run(new Date().toISOString(), new Date().toISOString());
  }

  close() { this.db.close(); }

  snapshot(configured: boolean): Snapshot {
    const p = this.db.prepare('SELECT name, shape, color FROM profile WHERE id=1').get() as Snapshot['profile'];
    return {
      profile: p,
      tasks: (this.db.prepare('SELECT * FROM tasks ORDER BY priority DESC, created_at DESC').all() as Record<string, unknown>[]).map(toTask),
      watches: (this.db.prepare('SELECT * FROM watches ORDER BY rowid DESC').all() as Record<string, unknown>[]).map(toWatch),
      entries: (this.db.prepare('SELECT id, task_id, kind, body, created_at FROM entries ORDER BY id DESC LIMIT 150').all() as Record<string, unknown>[]).map(toEntry).reverse(),
      configured,
    };
  }

  createTask(instruction: string, scheduleMinutes: number | null = null): Task {
    const now = new Date().toISOString();
    const id = randomUUID();
    const title = instruction.trim().split(/[.!?。！？\n]/)[0].slice(0, 64) || '新任务';
    this.db.prepare('INSERT INTO tasks VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(id, title, instruction.trim(), 'queued', 0, now, scheduleMinutes, null, null, now, now);
    this.addEntry('user', instruction.trim(), id);
    this.addEntry('system', scheduleMinutes ? `已安排每 ${scheduleMinutes} 分钟检查一次。` : '已加入工作队列。', id);
    return this.getTask(id)!;
  }

  getTask(id: string): Task | null {
    const row = this.db.prepare('SELECT * FROM tasks WHERE id=?').get(id) as Record<string, unknown> | undefined;
    return row ? toTask(row) : null;
  }

  dueTasks(now = new Date().toISOString()): Task[] {
    return (this.db.prepare("SELECT * FROM tasks WHERE status IN ('queued','scheduled') AND next_run_at <= ? ORDER BY priority DESC, next_run_at ASC LIMIT 10").all(now) as Record<string, unknown>[]).map(toTask);
  }

  updateTask(id: string, change: Partial<Pick<Task, 'status' | 'priority' | 'instruction' | 'nextRunAt' | 'result' | 'error' | 'scheduleMinutes'>>): Task | null {
    const old = this.getTask(id);
    if (!old) return null;
    const next = { ...old, ...change, updatedAt: new Date().toISOString() };
    this.db.prepare('UPDATE tasks SET instruction=?,status=?,priority=?,next_run_at=?,schedule_minutes=?,result=?,error=?,updated_at=? WHERE id=?')
      .run(next.instruction, next.status, next.priority, next.nextRunAt, next.scheduleMinutes, next.result, next.error, next.updatedAt, id);
    return this.getTask(id);
  }

  addEntry(kind: Entry['kind'], body: string, taskId: string | null = null): Entry {
    const now = new Date().toISOString();
    const result = this.db.prepare('INSERT INTO entries(task_id,kind,body,created_at) VALUES (?,?,?,?)').run(taskId, kind, body, now);
    return { id: Number(result.lastInsertRowid), taskId, kind, body, createdAt: now };
  }

  setProfile(name: string, shape: string, color: string) {
    this.db.prepare('UPDATE profile SET name=?, shape=?, color=? WHERE id=1').run(name, shape, color);
  }

  createWatch(url: string, intervalMinutes: number): Watch {
    const id = randomUUID();
    this.db.prepare('INSERT INTO watches VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(id, url, intervalMinutes, 'active', new Date().toISOString(), null, null, null, null);
    this.addEntry('system', `开始只读检查：${url}`);
    return this.getWatch(id)!;
  }

  getWatch(id: string): Watch | null {
    const row = this.db.prepare('SELECT * FROM watches WHERE id=?').get(id) as Record<string, unknown> | undefined;
    return row ? toWatch(row) : null;
  }

  dueWatches(now = new Date().toISOString()): Watch[] {
    return (this.db.prepare("SELECT * FROM watches WHERE status='active' AND next_check_at <= ? LIMIT 10").all(now) as Record<string, unknown>[]).map(toWatch);
  }

  updateWatch(id: string, change: Partial<Watch> & { lastHash?: string | null }) {
    const old = this.getWatch(id);
    if (!old) return null;
    const next = { ...old, ...change };
    const oldHash = (this.db.prepare('SELECT last_hash FROM watches WHERE id=?').get(id) as { last_hash: string | null }).last_hash;
    this.db.prepare('UPDATE watches SET status=?,next_check_at=?,last_checked_at=?,last_hash=?,last_status=?,error=? WHERE id=?')
      .run(next.status, next.nextCheckAt, next.lastCheckedAt, change.lastHash === undefined ? oldHash : change.lastHash, next.lastStatus, next.error, id);
    return this.getWatch(id);
  }

  watchHash(id: string): string | null {
    const row = this.db.prepare('SELECT last_hash FROM watches WHERE id=?').get(id) as { last_hash: string | null } | undefined;
    return row?.last_hash || null;
  }
}

function toTask(r: Record<string, unknown>): Task {
  return {
    id: String(r.id), title: String(r.title), instruction: String(r.instruction),
    status: r.status as TaskStatus, priority: Number(r.priority),
    nextRunAt: r.next_run_at == null ? null : String(r.next_run_at),
    scheduleMinutes: r.schedule_minutes == null ? null : Number(r.schedule_minutes),
    result: r.result == null ? null : String(r.result),
    error: r.error == null ? null : String(r.error),
    createdAt: String(r.created_at), updatedAt: String(r.updated_at),
  };
}

function toEntry(r: Record<string, unknown>): Entry {
  return { id: Number(r.id), taskId: r.task_id == null ? null : String(r.task_id), kind: r.kind as Entry['kind'], body: String(r.body), createdAt: String(r.created_at) };
}

function toWatch(r: Record<string, unknown>): Watch {
  return {
    id: String(r.id), url: String(r.url), intervalMinutes: Number(r.interval_minutes),
    status: r.status as Watch['status'],
    nextCheckAt: r.next_check_at == null ? null : String(r.next_check_at),
    lastCheckedAt: r.last_checked_at == null ? null : String(r.last_checked_at),
    lastStatus: r.last_status == null ? null : String(r.last_status),
    error: r.error == null ? null : String(r.error),
  };
}

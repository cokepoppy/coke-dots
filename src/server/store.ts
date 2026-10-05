import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Engine, Entry, Snapshot, Task, TaskStatus, Watch } from '../shared/types.ts';

export interface GoogleIdentity { subject: string; email: string; name: string }
export interface AppUser { id: string; email: string; name: string }
export interface TenantSummary { id: string; name: string; role: string; kind: string }
export interface TenantMember { id: string; email: string; name: string; role: string }
export interface AuthSession { tokenHash: string; user: AppUser; tenant: TenantSummary; expiresAt: string }
export interface OAuthFlow { stateHash: string; nonce: string; codeVerifier: string; expiresAt: string; handoffHash?: string | null; returnTo?: string | null }

export class Store {
  readonly db: DatabaseSync;

  constructor(directory: string) {
    mkdirSync(directory, { recursive: true });
    this.db = new DatabaseSync(join(directory, 'dots.db'));
    this.db.exec(`
      PRAGMA journal_mode=WAL;
      CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY, issuer TEXT NOT NULL, subject TEXT NOT NULL,
        email TEXT NOT NULL, name TEXT NOT NULL, created_at TEXT NOT NULL,
        UNIQUE(issuer, subject)
      );
      CREATE TABLE IF NOT EXISTS tenants (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, kind TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS memberships (
        tenant_id TEXT NOT NULL REFERENCES tenants(id), user_id TEXT NOT NULL REFERENCES users(id),
        role TEXT NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY(tenant_id, user_id)
      );
      CREATE INDEX IF NOT EXISTS memberships_user ON memberships(user_id, tenant_id);
      CREATE TABLE IF NOT EXISTS auth_sessions (
        token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id),
        active_tenant_id TEXT NOT NULL REFERENCES tenants(id), created_at TEXT NOT NULL, expires_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS oauth_flows (
        state_hash TEXT PRIMARY KEY, nonce TEXT NOT NULL, code_verifier TEXT NOT NULL, expires_at TEXT NOT NULL, handoff_hash TEXT, return_to TEXT
      );
      CREATE TABLE IF NOT EXISTS desktop_handoffs (
        handoff_hash TEXT PRIMARY KEY, user_id TEXT REFERENCES users(id), tenant_id TEXT REFERENCES tenants(id), expires_at TEXT NOT NULL
      );
      INSERT OR IGNORE INTO tenants(id,name,kind,created_at) VALUES ('legacy','Personal workspace','personal',datetime('now'));
      CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL DEFAULT 'legacy', title TEXT NOT NULL, instruction TEXT NOT NULL,
        status TEXT NOT NULL, priority INTEGER NOT NULL, next_run_at TEXT,
        schedule_minutes INTEGER, result TEXT, error TEXT,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
        engine TEXT NOT NULL DEFAULT 'model', agent_session_id TEXT
      );
      CREATE TABLE IF NOT EXISTS entries (
        id INTEGER PRIMARY KEY AUTOINCREMENT, tenant_id TEXT NOT NULL DEFAULT 'legacy', task_id TEXT,
        kind TEXT NOT NULL, body TEXT NOT NULL, created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS watches (
        id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL DEFAULT 'legacy', url TEXT NOT NULL, interval_minutes INTEGER NOT NULL,
        status TEXT NOT NULL, next_check_at TEXT, last_checked_at TEXT,
        last_hash TEXT, last_status TEXT, error TEXT
      );
      CREATE TABLE IF NOT EXISTS tenant_profiles (
        tenant_id TEXT PRIMARY KEY REFERENCES tenants(id), name TEXT NOT NULL, shape TEXT NOT NULL, color TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS tenant_settings (
        tenant_id TEXT NOT NULL REFERENCES tenants(id), key TEXT NOT NULL, value TEXT NOT NULL,
        PRIMARY KEY(tenant_id,key)
      );
    `);

    // Migrate the pre-auth single-user database into a reserved workspace. Its records
    // are claimed only when the first Google account signs in on this local instance.
    this.addColumnIfMissing('tasks', 'tenant_id', "TEXT NOT NULL DEFAULT 'legacy'");
    this.addColumnIfMissing('entries', 'tenant_id', "TEXT NOT NULL DEFAULT 'legacy'");
    this.addColumnIfMissing('watches', 'tenant_id', "TEXT NOT NULL DEFAULT 'legacy'");
    this.addColumnIfMissing('oauth_flows', 'handoff_hash', 'TEXT');
    this.addColumnIfMissing('oauth_flows', 'return_to', 'TEXT');
    this.addColumnIfMissing('tasks', 'engine', "TEXT NOT NULL DEFAULT 'model'");
    this.addColumnIfMissing('tasks', 'agent_session_id', 'TEXT');
    const oldProfile = this.tableExists('profile');
    if (oldProfile) this.db.exec("INSERT OR IGNORE INTO tenant_profiles(tenant_id,name,shape,color) SELECT 'legacy',name,shape,color FROM profile WHERE id=1");
    this.db.exec("INSERT OR IGNORE INTO tenant_profiles(tenant_id,name,shape,color) VALUES ('legacy','Dot','circle','#ba9af7')");
    if (this.tableExists('settings')) this.db.exec("INSERT OR IGNORE INTO tenant_settings(tenant_id,key,value) SELECT 'legacy',key,value FROM settings");
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS tasks_due ON tasks(status, next_run_at, priority);
      CREATE INDEX IF NOT EXISTS tasks_tenant ON tasks(tenant_id, created_at);
      CREATE INDEX IF NOT EXISTS entries_task ON entries(tenant_id, task_id, id);
      CREATE INDEX IF NOT EXISTS watches_due ON watches(status, next_check_at);
      CREATE INDEX IF NOT EXISTS watches_tenant ON watches(tenant_id, status, next_check_at);
    `);
    const now = new Date().toISOString();
    this.db.prepare("UPDATE tasks SET status='queued', next_run_at=?, updated_at=? WHERE status='working'").run(now, now);
    this.db.prepare('DELETE FROM auth_sessions WHERE expires_at <= ?').run(now);
    this.db.prepare('DELETE FROM oauth_flows WHERE expires_at <= ?').run(now);
    this.db.prepare('DELETE FROM desktop_handoffs WHERE expires_at <= ?').run(now);
  }

  close() { this.db.close(); }

  private tableExists(name: string) {
    return Boolean(this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name));
  }

  private addColumnIfMissing(table: string, name: string, declaration: string) {
    const columns = this.db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
    if (!columns.some(column => column.name === name)) this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${declaration}`);
  }

  createOAuthFlow(flow: OAuthFlow) {
    this.db.prepare('INSERT INTO oauth_flows(state_hash,nonce,code_verifier,expires_at,handoff_hash,return_to) VALUES (?,?,?,?,?,?)')
      .run(flow.stateHash, flow.nonce, flow.codeVerifier, flow.expiresAt, flow.handoffHash || null, flow.returnTo || null);
  }

  consumeOAuthFlow(stateHash: string, now = new Date().toISOString()): Omit<OAuthFlow, 'stateHash'> | null {
    const row = this.db.prepare('SELECT nonce,code_verifier,expires_at,handoff_hash,return_to FROM oauth_flows WHERE state_hash=?').get(stateHash) as { nonce: string; code_verifier: string; expires_at: string; handoff_hash: string | null; return_to: string | null } | undefined;
    this.db.prepare('DELETE FROM oauth_flows WHERE state_hash=?').run(stateHash);
    if (!row || row.expires_at <= now) return null;
    return { nonce: row.nonce, codeVerifier: row.code_verifier, expiresAt: row.expires_at, handoffHash: row.handoff_hash, returnTo: row.return_to };
  }

  createDesktopHandoff(handoffHash: string, expiresAt: string) {
    this.db.prepare('INSERT INTO desktop_handoffs(handoff_hash,expires_at) VALUES (?,?)').run(handoffHash, expiresAt);
  }

  completeDesktopHandoff(handoffHash: string, userId: string, tenantId: string) {
    this.db.prepare('UPDATE desktop_handoffs SET user_id=?,tenant_id=? WHERE handoff_hash=? AND expires_at>?')
      .run(userId, tenantId, handoffHash, new Date().toISOString());
  }

  cancelDesktopHandoff(handoffHash: string) {
    this.db.prepare('DELETE FROM desktop_handoffs WHERE handoff_hash=?').run(handoffHash);
  }

  claimDesktopHandoff(handoffHash: string, now = new Date().toISOString()): { userId: string; tenantId: string } | 'pending' | null {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const row = this.db.prepare('SELECT user_id,tenant_id,expires_at FROM desktop_handoffs WHERE handoff_hash=?').get(handoffHash) as { user_id: string | null; tenant_id: string | null; expires_at: string } | undefined;
      if (!row || row.expires_at <= now) {
        this.db.prepare('DELETE FROM desktop_handoffs WHERE handoff_hash=?').run(handoffHash);
        this.db.exec('COMMIT');
        return null;
      }
      if (!row.user_id || !row.tenant_id) { this.db.exec('COMMIT'); return 'pending'; }
      this.db.prepare('DELETE FROM desktop_handoffs WHERE handoff_hash=?').run(handoffHash);
      this.db.exec('COMMIT');
      return { userId: row.user_id, tenantId: row.tenant_id };
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }

  signInGoogle(identity: GoogleIdentity): { user: AppUser; tenant: TenantSummary } {
    const now = new Date().toISOString();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      let row = this.db.prepare('SELECT id FROM users WHERE issuer=? AND subject=?').get('https://accounts.google.com', identity.subject) as { id: string } | undefined;
      if (row) {
        this.db.prepare('UPDATE users SET email=?,name=? WHERE id=?').run(identity.email, identity.name, row.id);
      } else {
        const userId = randomUUID();
        this.db.prepare('INSERT INTO users(id,issuer,subject,email,name,created_at) VALUES (?,?,?,?,?,?)')
          .run(userId, 'https://accounts.google.com', identity.subject, identity.email, identity.name, now);
        row = { id: userId };
      }
      let tenant = this.db.prepare(`SELECT t.id,t.name,t.kind,m.role FROM memberships m JOIN tenants t ON t.id=m.tenant_id
        WHERE m.user_id=? AND t.kind='personal' ORDER BY m.created_at LIMIT 1`).get(row.id) as TenantSummary | undefined;
      if (!tenant) {
        const legacyMembers = this.db.prepare("SELECT COUNT(*) AS count FROM memberships WHERE tenant_id='legacy'").get() as { count: number };
        let tenantId: string;
        if (legacyMembers.count === 0) {
          tenantId = 'legacy';
          this.db.prepare("UPDATE tenants SET name=? WHERE id='legacy'").run(`${identity.name || 'My'} workspace`);
        } else {
          tenantId = randomUUID();
          this.db.prepare('INSERT INTO tenants(id,name,kind,created_at) VALUES (?,?,?,?)').run(tenantId, `${identity.name || 'My'} workspace`, 'personal', now);
          this.db.prepare('INSERT INTO tenant_profiles(tenant_id,name,shape,color) VALUES (?,?,?,?)').run(tenantId, 'Dot', 'circle', '#ba9af7');
        }
        this.db.prepare('INSERT OR IGNORE INTO memberships(tenant_id,user_id,role,created_at) VALUES (?,?,?,?)').run(tenantId, row.id, 'owner', now);
        tenant = this.db.prepare('SELECT t.id,t.name,t.kind,m.role FROM memberships m JOIN tenants t ON t.id=m.tenant_id WHERE m.tenant_id=? AND m.user_id=?').get(tenantId, row.id) as unknown as TenantSummary;
      }
      this.db.exec('COMMIT');
      const user = this.db.prepare('SELECT id,email,name FROM users WHERE id=?').get(row.id) as unknown as AppUser;
      return { user, tenant };
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  createSession(tokenHash: string, userId: string, tenantId: string, expiresAt: string) {
    const now = new Date().toISOString();
    const member = this.db.prepare('SELECT 1 FROM memberships WHERE user_id=? AND tenant_id=?').get(userId, tenantId);
    if (!member) throw new Error('Workspace membership is required');
    this.db.prepare('INSERT INTO auth_sessions(token_hash,user_id,active_tenant_id,created_at,expires_at) VALUES (?,?,?,?,?)')
      .run(tokenHash, userId, tenantId, now, expiresAt);
  }

  getSession(tokenHash: string, now = new Date().toISOString()): AuthSession | null {
    const row = this.db.prepare(`SELECT s.token_hash,s.expires_at,u.id AS user_id,u.email,u.name,
      t.id AS tenant_id,t.name AS tenant_name,t.kind,m.role
      FROM auth_sessions s JOIN users u ON u.id=s.user_id
      JOIN memberships m ON m.user_id=s.user_id AND m.tenant_id=s.active_tenant_id
      JOIN tenants t ON t.id=s.active_tenant_id
      WHERE s.token_hash=? AND s.expires_at>?`).get(tokenHash, now) as Record<string, unknown> | undefined;
    if (!row) return null;
    return {
      tokenHash: String(row.token_hash), expiresAt: String(row.expires_at),
      user: { id: String(row.user_id), email: String(row.email), name: String(row.name) },
      tenant: { id: String(row.tenant_id), name: String(row.tenant_name), kind: String(row.kind), role: String(row.role) },
    };
  }

  tenantsForUser(userId: string): TenantSummary[] {
    return this.db.prepare('SELECT t.id,t.name,t.kind,m.role FROM memberships m JOIN tenants t ON t.id=m.tenant_id WHERE m.user_id=? ORDER BY t.kind,t.name')
      .all(userId) as unknown as TenantSummary[];
  }

  selectSessionTenant(tokenHash: string, userId: string, tenantId: string): boolean {
    const result = this.db.prepare('UPDATE auth_sessions SET active_tenant_id=? WHERE token_hash=? AND user_id=? AND EXISTS (SELECT 1 FROM memberships WHERE memberships.tenant_id=? AND memberships.user_id=?)')
      .run(tenantId, tokenHash, userId, tenantId, userId);
    return Number(result.changes) === 1;
  }

  createWorkspace(userId: string, name: string): TenantSummary {
    const tenantId = randomUUID();
    const now = new Date().toISOString();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare('INSERT INTO tenants(id,name,kind,created_at) VALUES (?,?,?,?)').run(tenantId, name, 'workspace', now);
      this.db.prepare('INSERT INTO memberships(tenant_id,user_id,role,created_at) VALUES (?,?,?,?)').run(tenantId, userId, 'owner', now);
      this.db.prepare('INSERT INTO tenant_profiles(tenant_id,name,shape,color) VALUES (?,?,?,?)').run(tenantId, 'Dot', 'circle', '#ba9af7');
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
    return this.db.prepare('SELECT t.id,t.name,t.kind,m.role FROM memberships m JOIN tenants t ON t.id=m.tenant_id WHERE m.user_id=? AND t.id=?').get(userId, tenantId) as unknown as TenantSummary;
  }

  addWorkspaceMember(tenantId: string, actorUserId: string, email: string, role: 'admin' | 'member') {
    const admin = this.db.prepare("SELECT 1 FROM memberships WHERE tenant_id=? AND user_id=? AND role IN ('owner','admin')").get(tenantId, actorUserId);
    if (!admin) return { ok: false as const, error: '只有工作区所有者或管理员可以添加成员' };
    const user = this.db.prepare('SELECT id,email,name FROM users WHERE email=? COLLATE NOCASE').get(email) as AppUser | undefined;
    if (!user) return { ok: false as const, error: '该 Google 账号尚未登录 Coke Dots' };
    this.db.prepare('INSERT OR IGNORE INTO memberships(tenant_id,user_id,role,created_at) VALUES (?,?,?,?)').run(tenantId, user.id, role, new Date().toISOString());
    return { ok: true as const, user };
  }

  workspaceMembers(tenantId: string): TenantMember[] {
    return this.db.prepare('SELECT u.id,u.email,u.name,m.role FROM memberships m JOIN users u ON u.id=m.user_id WHERE m.tenant_id=? ORDER BY CASE m.role WHEN \'owner\' THEN 0 WHEN \'admin\' THEN 1 ELSE 2 END,u.name')
      .all(tenantId) as unknown as TenantMember[];
  }

  removeWorkspaceMember(tenantId: string, actorUserId: string, memberUserId: string) {
    const admin = this.db.prepare("SELECT 1 FROM memberships WHERE tenant_id=? AND user_id=? AND role IN ('owner','admin')").get(tenantId, actorUserId);
    if (!admin) return { ok: false as const, error: '只有工作区所有者或管理员可以移除成员' };
    const target = this.db.prepare('SELECT role FROM memberships WHERE tenant_id=? AND user_id=?').get(tenantId, memberUserId) as { role: string } | undefined;
    if (!target) return { ok: false as const, error: '成员不存在' };
    if (target.role === 'owner') return { ok: false as const, error: '不能移除工作区所有者' };
    this.db.prepare('DELETE FROM memberships WHERE tenant_id=? AND user_id=?').run(tenantId, memberUserId);
    this.db.prepare('DELETE FROM auth_sessions WHERE user_id=? AND active_tenant_id=?').run(memberUserId, tenantId);
    return { ok: true as const };
  }

  removeSession(tokenHash: string) { this.db.prepare('DELETE FROM auth_sessions WHERE token_hash=?').run(tokenHash); }

  snapshot(configured: boolean, availableEngines: Engine[] = [], modelSettings: Snapshot['modelSettings'] = { baseUrl: '', model: '', hasKey: false }, tenantId = 'legacy'): Snapshot {
    const p = this.db.prepare('SELECT name,shape,color FROM tenant_profiles WHERE tenant_id=?').get(tenantId) as Snapshot['profile'] | undefined;
    if (!p) throw new Error('Workspace profile is missing');
    return {
      profile: p,
      preferences: { desktopNotifications: this.getSetting('desktopNotifications', tenantId) === 'true' },
      tasks: (this.db.prepare('SELECT * FROM tasks WHERE tenant_id=? ORDER BY priority DESC,created_at DESC').all(tenantId) as Record<string, unknown>[]).map(toTask),
      watches: (this.db.prepare('SELECT * FROM watches WHERE tenant_id=? ORDER BY rowid DESC').all(tenantId) as Record<string, unknown>[]).map(toWatch),
      entries: (this.db.prepare('SELECT id,tenant_id,task_id,kind,body,created_at FROM entries WHERE tenant_id=? ORDER BY id DESC LIMIT 150').all(tenantId) as Record<string, unknown>[]).map(toEntry).reverse(),
      configured, availableEngines, modelSettings,
    };
  }

  createTask(instruction: string, scheduleMinutes: number | null = null, engine: Engine = 'model', tenantId = 'legacy'): Task {
    const now = new Date().toISOString();
    const id = randomUUID();
    const title = instruction.trim().split(/[.!?。！？\n]/)[0].slice(0, 64) || '新任务';
    this.db.prepare('INSERT INTO tasks (id,tenant_id,title,instruction,status,priority,next_run_at,schedule_minutes,result,error,created_at,updated_at,engine,agent_session_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(id, tenantId, title, instruction.trim(), 'queued', 0, now, scheduleMinutes, null, null, now, now, engine, null);
    this.addEntry('user', instruction.trim(), id, tenantId);
    this.addEntry('system', scheduleMinutes ? `已安排每 ${scheduleMinutes} 分钟检查一次。` : '已加入工作队列。', id, tenantId);
    return this.getTask(id, tenantId)!;
  }

  getTask(id: string, tenantId = 'legacy'): Task | null {
    const row = this.db.prepare('SELECT * FROM tasks WHERE tenant_id=? AND id=?').get(tenantId, id) as Record<string, unknown> | undefined;
    return row ? toTask(row) : null;
  }

  dueTasks(now = new Date().toISOString()): Task[] {
    return (this.db.prepare(`WITH ranked AS (
      SELECT *,ROW_NUMBER() OVER (PARTITION BY tenant_id ORDER BY priority DESC,next_run_at ASC) AS tenant_rank
      FROM tasks WHERE status IN ('queued','scheduled') AND next_run_at<=?
    ) SELECT * FROM ranked WHERE tenant_rank<=2 ORDER BY priority DESC,next_run_at ASC LIMIT 100`).all(now) as Record<string, unknown>[]).map(toTask);
  }

  updateTask(id: string, change: Partial<Pick<Task, 'status' | 'priority' | 'instruction' | 'nextRunAt' | 'result' | 'error' | 'scheduleMinutes' | 'agentSessionId'>>, tenantId = 'legacy'): Task | null {
    const old = this.getTask(id, tenantId);
    if (!old) return null;
    const next = { ...old, ...change, updatedAt: new Date().toISOString() };
    this.db.prepare('UPDATE tasks SET instruction=?,status=?,priority=?,next_run_at=?,schedule_minutes=?,result=?,error=?,updated_at=?,agent_session_id=? WHERE tenant_id=? AND id=?')
      .run(next.instruction, next.status, next.priority, next.nextRunAt, next.scheduleMinutes, next.result, next.error, next.updatedAt, next.agentSessionId, tenantId, id);
    return this.getTask(id, tenantId);
  }

  replyToTask(id: string, message: string, tenantId = 'legacy'): Task | null {
    const old = this.getTask(id, tenantId);
    if (!old) return null;
    if (old.status !== 'waiting') throw new Error('Task is not waiting for a reply');
    const reply = message.trim();
    if (!reply || reply.length > 5000) throw new Error('Invalid task reply');
    const now = new Date().toISOString();
    const instruction = `${old.instruction}\n\nUser reply: ${reply}`;
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const current = this.getTask(id, tenantId);
      if (!current) { this.db.exec('ROLLBACK'); return null; }
      if (current.status !== 'waiting') throw new Error('Task is not waiting for a reply');
      this.db.prepare("UPDATE tasks SET instruction=?,status='queued',next_run_at=?,error=NULL,updated_at=? WHERE tenant_id=? AND id=?")
        .run(instruction, now, now, tenantId, id);
      this.db.prepare('INSERT INTO entries(tenant_id,task_id,kind,body,created_at) VALUES (?,?,?,?,?)')
        .run(tenantId, id, 'user', reply, now);
      this.db.exec('COMMIT');
      return this.getTask(id, tenantId);
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }

  addEntry(kind: Entry['kind'], body: string, taskId: string | null = null, tenantId = 'legacy'): Entry {
    const now = new Date().toISOString();
    const result = this.db.prepare('INSERT INTO entries(tenant_id,task_id,kind,body,created_at) VALUES (?,?,?,?,?)').run(tenantId, taskId, kind, body, now);
    return { id: Number(result.lastInsertRowid), tenantId, taskId, kind, body, createdAt: now };
  }

  setProfile(name: string, shape: string, color: string, tenantId = 'legacy') {
    this.db.prepare('UPDATE tenant_profiles SET name=?,shape=?,color=? WHERE tenant_id=?').run(name, shape, color, tenantId);
  }

  getProfile(tenantId = 'legacy') {
    const profile = this.db.prepare('SELECT name,shape,color FROM tenant_profiles WHERE tenant_id=?').get(tenantId) as Snapshot['profile'] | undefined;
    if (!profile) throw new Error('Workspace profile is missing');
    return profile;
  }

  getSetting(key: string, tenantId = 'legacy'): string | null {
    const row = this.db.prepare('SELECT value FROM tenant_settings WHERE tenant_id=? AND key=?').get(tenantId, key) as { value: string } | undefined;
    return row?.value || null;
  }

  setSetting(key: string, value: string, tenantId = 'legacy') {
    this.db.prepare('INSERT INTO tenant_settings(tenant_id,key,value) VALUES (?,?,?) ON CONFLICT(tenant_id,key) DO UPDATE SET value=excluded.value').run(tenantId, key, value);
  }

  createWatch(url: string, intervalMinutes: number, tenantId = 'legacy'): Watch {
    const id = randomUUID();
    this.db.prepare('INSERT INTO watches(id,tenant_id,url,interval_minutes,status,next_check_at,last_checked_at,last_hash,last_status,error) VALUES (?,?,?,?,?,?,?,?,?,?)')
      .run(id, tenantId, url, intervalMinutes, 'active', new Date().toISOString(), null, null, null, null);
    this.addEntry('system', `开始只读检查：${url}`, null, tenantId);
    return this.getWatch(id, tenantId)!;
  }

  getWatch(id: string, tenantId = 'legacy'): Watch | null {
    const row = this.db.prepare('SELECT * FROM watches WHERE tenant_id=? AND id=?').get(tenantId, id) as Record<string, unknown> | undefined;
    return row ? toWatch(row) : null;
  }

  dueWatches(now = new Date().toISOString()): Watch[] {
    return (this.db.prepare("SELECT * FROM watches WHERE status='active' AND next_check_at<=? LIMIT 10").all(now) as Record<string, unknown>[]).map(toWatch);
  }

  updateWatch(id: string, change: Partial<Watch> & { lastHash?: string | null }, tenantId = 'legacy') {
    const old = this.getWatch(id, tenantId);
    if (!old) return null;
    const next = { ...old, ...change };
    const oldHash = (this.db.prepare('SELECT last_hash FROM watches WHERE tenant_id=? AND id=?').get(tenantId, id) as { last_hash: string | null }).last_hash;
    this.db.prepare('UPDATE watches SET status=?,next_check_at=?,last_checked_at=?,last_hash=?,last_status=?,error=? WHERE tenant_id=? AND id=?')
      .run(next.status, next.nextCheckAt, next.lastCheckedAt, change.lastHash === undefined ? oldHash : change.lastHash, next.lastStatus, next.error, tenantId, id);
    return this.getWatch(id, tenantId);
  }

  watchHash(id: string, tenantId = 'legacy'): string | null {
    const row = this.db.prepare('SELECT last_hash FROM watches WHERE tenant_id=? AND id=?').get(tenantId, id) as { last_hash: string | null } | undefined;
    return row?.last_hash || null;
  }
}

function toTask(r: Record<string, unknown>): Task {
  return {
    id: String(r.id), tenantId: String(r.tenant_id), title: String(r.title), instruction: String(r.instruction),
    engine: r.engine as Engine, agentSessionId: r.agent_session_id == null ? null : String(r.agent_session_id),
    status: r.status as TaskStatus, priority: Number(r.priority),
    nextRunAt: r.next_run_at == null ? null : String(r.next_run_at),
    scheduleMinutes: r.schedule_minutes == null ? null : Number(r.schedule_minutes),
    result: r.result == null ? null : String(r.result), error: r.error == null ? null : String(r.error),
    createdAt: String(r.created_at), updatedAt: String(r.updated_at),
  };
}

function toEntry(r: Record<string, unknown>): Entry {
  return { id: Number(r.id), tenantId: String(r.tenant_id), taskId: r.task_id == null ? null : String(r.task_id), kind: r.kind as Entry['kind'], body: String(r.body), createdAt: String(r.created_at) };
}

function toWatch(r: Record<string, unknown>): Watch {
  return {
    id: String(r.id), tenantId: String(r.tenant_id), url: String(r.url), intervalMinutes: Number(r.interval_minutes),
    status: r.status as Watch['status'], nextCheckAt: r.next_check_at == null ? null : String(r.next_check_at),
    lastCheckedAt: r.last_checked_at == null ? null : String(r.last_checked_at),
    lastStatus: r.last_status == null ? null : String(r.last_status), error: r.error == null ? null : String(r.error),
  };
}

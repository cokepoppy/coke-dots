import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { isReasoningEffort, type ActionRuleMode, type AppliedPersonalDotMemoryUpdate, type AttachmentSummary, type Engine, type Entry, type PageActionApproval, type PersonalDotMemory, type PersonalDotMemoryUpdate, type ReasoningEffort, type ScheduleSpec, type ScratchpadPageAction, type Snapshot, type Task, type TaskStatus, type TenantActionRule, type VoiceCallSession, type Watch, type WebsiteSignInRequest, type WorkspacePage } from '../shared/types.ts';
import { describeSchedule, scheduleForTask, validateScheduleSpec } from '../shared/scheduling.ts';

export interface GoogleIdentity { subject: string; email: string; name: string }
export interface AppUser { id: string; email: string; name: string }
export interface TenantSummary { id: string; name: string; role: string; kind: string }
export interface TenantMember { id: string; email: string; name: string; role: string }
export interface WorkspaceInvitation { tenantId: string; tenantName?: string; email: string; role: string; invitedAt: string; expiresAt: string }
export interface TenantMemory { id: string; tenantId: string; note: string; createdBy: string; createdByName: string; createdAt: string; updatedAt: string }
export interface AuthSession { tokenHash: string; user: AppUser; tenant: TenantSummary; expiresAt: string }
export interface OAuthFlow { stateHash: string; nonce: string; codeVerifier: string; expiresAt: string; handoffHash?: string | null; returnTo?: string | null }
export interface SlackOAuthFlow { stateHash: string; tenantId: string; userId: string; expiresAt: string; returnTo: string }
export interface SlackInstallation { tenantId: string; teamId: string; teamName: string; scopes: string[]; installedAt: string; contactEnabled: boolean }
export interface StoredTaskAttachment extends AttachmentSummary { tenantId: string; uploadedBy: string; taskId: string | null; content: Uint8Array; createdAt: string }
export type PersonalDotResetResult = 'ok' | 'not-found' | 'not-personal' | 'not-owner' | 'shared';

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
      CREATE TABLE IF NOT EXISTS workspace_invitations (
        tenant_id TEXT NOT NULL REFERENCES tenants(id), email TEXT NOT NULL COLLATE NOCASE,
        role TEXT NOT NULL CHECK (role IN ('admin','member')), invited_by TEXT NOT NULL REFERENCES users(id),
        invited_at TEXT NOT NULL, expires_at TEXT NOT NULL, PRIMARY KEY(tenant_id,email)
      );
      CREATE INDEX IF NOT EXISTS workspace_invitations_email ON workspace_invitations(email,expires_at);
      CREATE TABLE IF NOT EXISTS auth_sessions (
        token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id),
        active_tenant_id TEXT NOT NULL REFERENCES tenants(id), created_at TEXT NOT NULL, expires_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS oauth_flows (
        state_hash TEXT PRIMARY KEY, nonce TEXT NOT NULL, code_verifier TEXT NOT NULL, expires_at TEXT NOT NULL, handoff_hash TEXT, return_to TEXT
      );
      CREATE TABLE IF NOT EXISTS slack_oauth_flows (
        state_hash TEXT PRIMARY KEY, tenant_id TEXT NOT NULL REFERENCES tenants(id), user_id TEXT NOT NULL REFERENCES users(id),
        expires_at TEXT NOT NULL, return_to TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS slack_installations (
        tenant_id TEXT NOT NULL REFERENCES tenants(id), team_id TEXT NOT NULL, team_name TEXT NOT NULL,
        scopes_json TEXT NOT NULL, installed_at TEXT NOT NULL,
        contact_enabled INTEGER NOT NULL DEFAULT 0 CHECK(contact_enabled IN (0,1)), PRIMARY KEY(tenant_id,team_id)
      );
      CREATE UNIQUE INDEX IF NOT EXISTS slack_one_contact_per_tenant ON slack_installations(tenant_id) WHERE contact_enabled=1;
      CREATE TABLE IF NOT EXISTS desktop_handoffs (
        handoff_hash TEXT PRIMARY KEY, user_id TEXT REFERENCES users(id), tenant_id TEXT REFERENCES tenants(id), expires_at TEXT NOT NULL
      );
      INSERT OR IGNORE INTO tenants(id,name,kind,created_at) VALUES ('legacy','Personal workspace','personal',datetime('now'));
      CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL DEFAULT 'legacy', title TEXT NOT NULL, instruction TEXT NOT NULL,
        status TEXT NOT NULL, priority INTEGER NOT NULL, next_run_at TEXT,
        schedule_minutes INTEGER, result TEXT, error TEXT,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
        engine TEXT NOT NULL DEFAULT 'model', reasoning_effort TEXT NOT NULL DEFAULT 'high', agent_session_id TEXT, parent_task_id TEXT,
        execution_mode TEXT NOT NULL DEFAULT 'standard', task_context TEXT NOT NULL DEFAULT ''
      );
      CREATE TABLE IF NOT EXISTS entries (
        id INTEGER PRIMARY KEY AUTOINCREMENT, tenant_id TEXT NOT NULL DEFAULT 'legacy', task_id TEXT,
        kind TEXT NOT NULL, body TEXT NOT NULL, created_at TEXT NOT NULL, attachment_ids_json TEXT NOT NULL DEFAULT '[]'
      );
      CREATE TABLE IF NOT EXISTS task_attachments (
        id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL REFERENCES tenants(id), uploaded_by TEXT NOT NULL REFERENCES users(id),
        task_id TEXT REFERENCES tasks(id), name TEXT NOT NULL, media_type TEXT NOT NULL, size INTEGER NOT NULL CHECK(size > 0),
        content BLOB NOT NULL, created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS voice_calls (
        id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL REFERENCES tenants(id), user_id TEXT NOT NULL REFERENCES users(id),
        started_at TEXT NOT NULL, ended_at TEXT, duration_seconds INTEGER CHECK(duration_seconds IS NULL OR duration_seconds >= 0)
      );
      CREATE INDEX IF NOT EXISTS voice_calls_owner ON voice_calls(tenant_id,user_id,started_at DESC);
      CREATE TABLE IF NOT EXISTS watches (
        id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL DEFAULT 'legacy', url TEXT NOT NULL, interval_minutes INTEGER NOT NULL,
        status TEXT NOT NULL, next_check_at TEXT, last_checked_at TEXT,
        last_hash TEXT, last_status TEXT, error TEXT, last_content TEXT, last_task_id TEXT
      );
      CREATE TABLE IF NOT EXISTS tenant_profiles (
        tenant_id TEXT PRIMARY KEY REFERENCES tenants(id), name TEXT NOT NULL, shape TEXT NOT NULL, color TEXT NOT NULL,
        eyes TEXT NOT NULL DEFAULT 'dot', glasses TEXT NOT NULL DEFAULT 'none', accessory TEXT NOT NULL DEFAULT 'none',
        character TEXT NOT NULL DEFAULT 'ring', pet TEXT NOT NULL DEFAULT 'moss',
        avatar_setup_completed_at TEXT, onboarding_completed_at TEXT, onboarding_completed_name TEXT
      );
      CREATE TABLE IF NOT EXISTS tenant_settings (
        tenant_id TEXT NOT NULL REFERENCES tenants(id), key TEXT NOT NULL, value TEXT NOT NULL,
        PRIMARY KEY(tenant_id,key)
      );
      CREATE TABLE IF NOT EXISTS dot_pause_tasks (
        tenant_id TEXT NOT NULL REFERENCES tenants(id), task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        next_run_at TEXT, PRIMARY KEY(tenant_id,task_id)
      );
      CREATE TABLE IF NOT EXISTS tenant_memories (
        id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL REFERENCES tenants(id),
        created_by TEXT NOT NULL REFERENCES users(id), note TEXT NOT NULL,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS tenant_memories_scope ON tenant_memories(tenant_id,created_at DESC);
      CREATE TABLE IF NOT EXISTS personal_dot_memories (
        id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), note TEXT NOT NULL,
        source_task_id TEXT REFERENCES tasks(id) ON DELETE SET NULL,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS personal_dot_memories_scope ON personal_dot_memories(user_id,created_at DESC);
      CREATE TABLE IF NOT EXISTS workspace_pages (
        id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL REFERENCES tenants(id),
        title TEXT NOT NULL, content TEXT NOT NULL,
        created_by TEXT REFERENCES users(id), source_task_id TEXT REFERENCES tasks(id),
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS workspace_pages_scope ON workspace_pages(tenant_id,updated_at DESC);
      CREATE UNIQUE INDEX IF NOT EXISTS workspace_pages_source_task ON workspace_pages(tenant_id,source_task_id) WHERE source_task_id IS NOT NULL;
      CREATE TABLE IF NOT EXISTS tenant_action_rules (
        id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL REFERENCES tenants(id), scope TEXT NOT NULL CHECK (scope='scratchpad-write'),
        instruction TEXT NOT NULL, mode TEXT NOT NULL CHECK (mode IN ('without-asking','when-requested','ask-before','hand-off')),
        created_by TEXT NOT NULL REFERENCES users(id), created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
        UNIQUE(tenant_id,scope)
      );
      CREATE TABLE IF NOT EXISTS page_action_approvals (
        id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL REFERENCES tenants(id), task_id TEXT NOT NULL REFERENCES tasks(id),
        action_json TEXT NOT NULL, message TEXT NOT NULL, status TEXT NOT NULL CHECK (status IN ('pending','approved','declined','cancelled')),
        resume_status TEXT NOT NULL CHECK (resume_status IN ('done','scheduled')), next_run_at TEXT,
        created_at TEXT NOT NULL, decided_at TEXT, decided_by TEXT REFERENCES users(id)
      );
      CREATE INDEX IF NOT EXISTS page_action_approvals_task ON page_action_approvals(tenant_id,task_id,created_at DESC);
      CREATE UNIQUE INDEX IF NOT EXISTS page_action_approvals_one_pending ON page_action_approvals(tenant_id,task_id) WHERE status='pending';
      CREATE TABLE IF NOT EXISTS website_sign_in_requests (
        id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL REFERENCES tenants(id), task_id TEXT NOT NULL REFERENCES tasks(id),
        url TEXT NOT NULL, hostname TEXT NOT NULL, reason TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('pending','submitted','continued','cancelled')),
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS website_sign_in_task ON website_sign_in_requests(tenant_id,task_id,created_at DESC);
      CREATE UNIQUE INDEX IF NOT EXISTS website_sign_in_one_pending ON website_sign_in_requests(tenant_id,task_id) WHERE status IN ('pending','submitted');
    `);

    // Migrate the pre-auth single-user database into a reserved workspace. Its records
    // are claimed only when the first Google account signs in on this local instance.
    this.addColumnIfMissing('tasks', 'tenant_id', "TEXT NOT NULL DEFAULT 'legacy'");
    this.addColumnIfMissing('entries', 'tenant_id', "TEXT NOT NULL DEFAULT 'legacy'");
    this.addColumnIfMissing('entries', 'attachment_ids_json', "TEXT NOT NULL DEFAULT '[]'");
    this.addColumnIfMissing('watches', 'tenant_id', "TEXT NOT NULL DEFAULT 'legacy'");
    this.addColumnIfMissing('oauth_flows', 'handoff_hash', 'TEXT');
    this.addColumnIfMissing('oauth_flows', 'return_to', 'TEXT');
    this.addColumnIfMissing('tasks', 'engine', "TEXT NOT NULL DEFAULT 'model'");
    this.addColumnIfMissing('tasks', 'reasoning_effort', "TEXT NOT NULL DEFAULT 'high'");
    this.addColumnIfMissing('tasks', 'agent_session_id', 'TEXT');
    this.addColumnIfMissing('tasks', 'schedule_json', 'TEXT');
    this.addColumnIfMissing('tasks', 'parent_task_id', 'TEXT');
    this.addColumnIfMissing('tasks', 'execution_mode', "TEXT NOT NULL DEFAULT 'standard'");
    this.addColumnIfMissing('tasks', 'task_context', "TEXT NOT NULL DEFAULT ''");
    this.addColumnIfMissing('watches', 'last_content', 'TEXT');
    this.addColumnIfMissing('watches', 'last_task_id', 'TEXT');
    this.addColumnIfMissing('page_action_approvals', 'decided_by', 'TEXT REFERENCES users(id)');
    this.addColumnIfMissing('tenant_profiles', 'eyes', "TEXT NOT NULL DEFAULT 'classic'");
    this.addColumnIfMissing('tenant_profiles', 'glasses', "TEXT NOT NULL DEFAULT 'none'");
    this.addColumnIfMissing('tenant_profiles', 'accessory', "TEXT NOT NULL DEFAULT 'none'");
    this.addColumnIfMissing('tenant_profiles', 'character', "TEXT NOT NULL DEFAULT 'custom'");
    this.addColumnIfMissing('tenant_profiles', 'pet', "TEXT NOT NULL DEFAULT 'moss'");
    this.addColumnIfMissing('tenant_profiles', 'avatar_setup_completed_at', 'TEXT');
    this.addColumnIfMissing('tenant_profiles', 'onboarding_completed_at', 'TEXT');
    this.addColumnIfMissing('tenant_profiles', 'onboarding_completed_name', 'TEXT');
    this.db.exec('UPDATE tenant_profiles SET avatar_setup_completed_at=onboarding_completed_at WHERE avatar_setup_completed_at IS NULL AND onboarding_completed_at IS NOT NULL');
    this.db.exec("UPDATE tenant_profiles SET character='custom' WHERE character='classic'");
    this.ensurePageApprovalCancellationStatus();
    const oldProfile = this.tableExists('profile');
    if (oldProfile) this.db.exec("INSERT OR IGNORE INTO tenant_profiles(tenant_id,name,shape,color) SELECT 'legacy',name,shape,color FROM profile WHERE id=1");
    this.db.exec("INSERT OR IGNORE INTO tenant_profiles(tenant_id,name,shape,color,eyes,character,pet) VALUES ('legacy','Dot','circle','#c8cbd5','dot','ring','moss')");
    if (this.tableExists('settings')) this.db.exec("INSERT OR IGNORE INTO tenant_settings(tenant_id,key,value) SELECT 'legacy',key,value FROM settings");
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS tasks_due ON tasks(status, next_run_at, priority);
      CREATE INDEX IF NOT EXISTS tasks_tenant ON tasks(tenant_id, created_at);
      CREATE INDEX IF NOT EXISTS tasks_parent ON tasks(tenant_id, parent_task_id, created_at);
      CREATE INDEX IF NOT EXISTS entries_task ON entries(tenant_id, task_id, id);
      CREATE INDEX IF NOT EXISTS entries_timeline ON entries(tenant_id, id DESC);
      CREATE INDEX IF NOT EXISTS task_attachments_pending ON task_attachments(tenant_id, uploaded_by, task_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS task_attachments_task ON task_attachments(tenant_id, task_id, created_at);
      CREATE INDEX IF NOT EXISTS watches_due ON watches(status, next_check_at);
      CREATE INDEX IF NOT EXISTS watches_tenant ON watches(tenant_id, status, next_check_at);
    `);
    const now = new Date().toISOString();
    this.db.prepare("UPDATE tasks SET status='queued', next_run_at=COALESCE(next_run_at,?), updated_at=? WHERE status='working'").run(now, now);
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

  private ensurePageApprovalCancellationStatus() {
    const schema = this.db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='page_action_approvals'").get() as { sql: string } | undefined;
    if (!schema || schema.sql.includes("'cancelled'")) return;
    this.db.exec(`
      BEGIN IMMEDIATE;
      DROP INDEX IF EXISTS page_action_approvals_task;
      DROP INDEX IF EXISTS page_action_approvals_one_pending;
      ALTER TABLE page_action_approvals RENAME TO page_action_approvals_legacy;
      CREATE TABLE page_action_approvals (
        id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL REFERENCES tenants(id), task_id TEXT NOT NULL REFERENCES tasks(id),
        action_json TEXT NOT NULL, message TEXT NOT NULL, status TEXT NOT NULL CHECK (status IN ('pending','approved','declined','cancelled')),
        resume_status TEXT NOT NULL CHECK (resume_status IN ('done','scheduled')), next_run_at TEXT,
        created_at TEXT NOT NULL, decided_at TEXT, decided_by TEXT REFERENCES users(id)
      );
      INSERT INTO page_action_approvals(id,tenant_id,task_id,action_json,message,status,resume_status,next_run_at,created_at,decided_at,decided_by)
        SELECT id,tenant_id,task_id,action_json,message,status,resume_status,next_run_at,created_at,decided_at,decided_by FROM page_action_approvals_legacy;
      DROP TABLE page_action_approvals_legacy;
      CREATE INDEX page_action_approvals_task ON page_action_approvals(tenant_id,task_id,created_at DESC);
      CREATE UNIQUE INDEX page_action_approvals_one_pending ON page_action_approvals(tenant_id,task_id) WHERE status='pending';
      COMMIT;
    `);
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

  createSlackOAuthFlow(flow: SlackOAuthFlow) {
    this.db.prepare('INSERT INTO slack_oauth_flows(state_hash,tenant_id,user_id,expires_at,return_to) VALUES (?,?,?,?,?)')
      .run(flow.stateHash, flow.tenantId, flow.userId, flow.expiresAt, flow.returnTo);
  }

  consumeSlackOAuthFlow(stateHash: string, now = new Date().toISOString()): Omit<SlackOAuthFlow, 'stateHash'> | null {
    const row = this.db.prepare('SELECT tenant_id,user_id,expires_at,return_to FROM slack_oauth_flows WHERE state_hash=?').get(stateHash) as
      { tenant_id: string; user_id: string; expires_at: string; return_to: string } | undefined;
    this.db.prepare('DELETE FROM slack_oauth_flows WHERE state_hash=?').run(stateHash);
    if (!row || row.expires_at <= now) return null;
    return { tenantId: row.tenant_id, userId: row.user_id, expiresAt: row.expires_at, returnTo: row.return_to };
  }

  installSlackWorkspace(installation: Omit<SlackInstallation, 'contactEnabled'>) {
    this.db.prepare(`INSERT INTO slack_installations(tenant_id,team_id,team_name,scopes_json,installed_at,contact_enabled)
      VALUES (?,?,?,?,?,0) ON CONFLICT(tenant_id,team_id) DO UPDATE SET
      team_name=excluded.team_name,scopes_json=excluded.scopes_json,installed_at=excluded.installed_at`)
      .run(installation.tenantId, installation.teamId, installation.teamName, JSON.stringify(installation.scopes), installation.installedAt);
  }

  slackInstallations(tenantId: string): SlackInstallation[] {
    const rows = this.db.prepare(`SELECT tenant_id AS tenantId,team_id AS teamId,team_name AS teamName,
      scopes_json AS scopesJson,installed_at AS installedAt,contact_enabled AS contactEnabled
      FROM slack_installations WHERE tenant_id=? ORDER BY team_name COLLATE NOCASE,team_id`).all(tenantId) as unknown as
      { tenantId: string; teamId: string; teamName: string; scopesJson: string; installedAt: string; contactEnabled: number }[];
    return rows.map(row => ({ tenantId: row.tenantId, teamId: row.teamId, teamName: row.teamName,
      installedAt: row.installedAt, scopes: JSON.parse(row.scopesJson) as string[],
      contactEnabled: row.contactEnabled === 1 }));
  }

  setSlackContactWorkspace(tenantId: string, teamId: string): boolean {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const exists = this.db.prepare('SELECT 1 FROM slack_installations WHERE tenant_id=? AND team_id=?').get(tenantId, teamId);
      if (!exists) { this.db.exec('COMMIT'); return false; }
      this.db.prepare('UPDATE slack_installations SET contact_enabled=0 WHERE tenant_id=?').run(tenantId);
      this.db.prepare('UPDATE slack_installations SET contact_enabled=1 WHERE tenant_id=? AND team_id=?').run(tenantId, teamId);
      this.db.exec('COMMIT');
      return true;
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }

  slackInstallation(tenantId: string, teamId: string) {
    return this.slackInstallations(tenantId).find(item => item.teamId === teamId) || null;
  }

  removeSlackInstallation(tenantId: string, teamId: string) {
    return Number(this.db.prepare('DELETE FROM slack_installations WHERE tenant_id=? AND team_id=?').run(tenantId, teamId).changes) > 0;
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
          this.db.prepare('INSERT INTO tenant_profiles(tenant_id,name,shape,color,eyes,character,pet) VALUES (?,?,?,?,?,?,?)').run(tenantId, 'Dot', 'circle', '#c8cbd5', 'dot', 'ring', 'moss');
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
      this.db.prepare('INSERT INTO tenant_profiles(tenant_id,name,shape,color,eyes,character,pet) VALUES (?,?,?,?,?,?,?)').run(tenantId, 'Dot', 'circle', '#c8cbd5', 'dot', 'ring', 'moss');
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
    return this.db.prepare('SELECT t.id,t.name,t.kind,m.role FROM memberships m JOIN tenants t ON t.id=m.tenant_id WHERE m.user_id=? AND t.id=?').get(userId, tenantId) as unknown as TenantSummary;
  }

  addWorkspaceMember(tenantId: string, actorUserId: string, email: string, role: 'admin' | 'member') {
    const admin = this.db.prepare("SELECT 1 FROM memberships WHERE tenant_id=? AND user_id=? AND role IN ('owner','admin')").get(tenantId, actorUserId);
    if (!admin) return { ok: false as const, error: '只有工作区所有者或管理员可以添加成员' };
    const user = this.db.prepare('SELECT id,email,name FROM users WHERE email=? COLLATE NOCASE').get(email) as AppUser | undefined;
    if (user && this.db.prepare('SELECT 1 FROM memberships WHERE tenant_id=? AND user_id=?').get(tenantId, user.id)) {
      return { ok: true as const, kind: 'member' as const, user };
    }
    // Never grant a workspace based only on a stored email match. Even accounts
    // that have signed in before must authenticate and explicitly accept.
    const invitedAt = new Date().toISOString();
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
    this.db.prepare(`INSERT INTO workspace_invitations(tenant_id,email,role,invited_by,invited_at,expires_at)
      VALUES(?,?,?,?,?,?) ON CONFLICT(tenant_id,email) DO UPDATE SET role=excluded.role,invited_by=excluded.invited_by,invited_at=excluded.invited_at,expires_at=excluded.expires_at`)
      .run(tenantId, email, role, actorUserId, invitedAt, expiresAt);
    return { ok: true as const, kind: 'invitation' as const, invitation: { tenantId, email, role, invitedAt, expiresAt } };
  }

  workspaceInvitations(tenantId: string, actorUserId: string, now = new Date().toISOString()): WorkspaceInvitation[] | null {
    const admin = this.db.prepare("SELECT 1 FROM memberships WHERE tenant_id=? AND user_id=? AND role IN ('owner','admin')").get(tenantId, actorUserId);
    if (!admin) return null;
    this.db.prepare('DELETE FROM workspace_invitations WHERE tenant_id=? AND expires_at<=?').run(tenantId, now);
    return this.db.prepare('SELECT tenant_id AS tenantId,email,role,invited_at AS invitedAt,expires_at AS expiresAt FROM workspace_invitations WHERE tenant_id=? AND expires_at>? ORDER BY invited_at DESC')
      .all(tenantId, now) as unknown as WorkspaceInvitation[];
  }

  revokeWorkspaceInvitation(tenantId: string, actorUserId: string, email: string) {
    const admin = this.db.prepare("SELECT 1 FROM memberships WHERE tenant_id=? AND user_id=? AND role IN ('owner','admin')").get(tenantId, actorUserId);
    if (!admin) return { ok: false as const, error: '只有工作区所有者或管理员可以撤销邀请' };
    const result = this.db.prepare('DELETE FROM workspace_invitations WHERE tenant_id=? AND email=? COLLATE NOCASE').run(tenantId, email);
    return Number(result.changes) ? { ok: true as const } : { ok: false as const, error: '邀请不存在或已过期' };
  }

  pendingWorkspaceInvitations(email: string, now = new Date().toISOString()): WorkspaceInvitation[] {
    this.db.prepare('DELETE FROM workspace_invitations WHERE expires_at<=?').run(now);
    return this.db.prepare(`SELECT i.tenant_id AS tenantId,t.name AS tenantName,i.email,i.role,i.invited_at AS invitedAt,i.expires_at AS expiresAt
      FROM workspace_invitations i JOIN tenants t ON t.id=i.tenant_id WHERE i.email=? COLLATE NOCASE AND i.expires_at>? ORDER BY i.invited_at DESC`)
      .all(email, now) as unknown as WorkspaceInvitation[];
  }

  acceptWorkspaceInvitation(tenantId: string, tokenHash: string, userId: string, email: string, now = new Date().toISOString()): TenantSummary | null {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const invite = this.db.prepare('SELECT role,expires_at FROM workspace_invitations WHERE tenant_id=? AND email=? COLLATE NOCASE')
        .get(tenantId, email) as { role: string; expires_at: string } | undefined;
      if (!invite || invite.expires_at <= now) {
        if (invite) this.db.prepare('DELETE FROM workspace_invitations WHERE tenant_id=? AND email=? COLLATE NOCASE').run(tenantId, email);
        this.db.exec('COMMIT');
        return null;
      }
      this.db.prepare('INSERT OR IGNORE INTO memberships(tenant_id,user_id,role,created_at) VALUES (?,?,?,?)')
        .run(tenantId, userId, invite.role, now);
      this.db.prepare('DELETE FROM workspace_invitations WHERE tenant_id=? AND email=? COLLATE NOCASE').run(tenantId, email);
      this.db.prepare('UPDATE auth_sessions SET active_tenant_id=? WHERE token_hash=? AND user_id=?').run(tenantId, tokenHash, userId);
      const tenant = this.db.prepare(`SELECT t.id,t.name,t.kind,m.role FROM memberships m JOIN tenants t ON t.id=m.tenant_id
        WHERE m.tenant_id=? AND m.user_id=?`).get(tenantId, userId) as TenantSummary | undefined;
      if (!tenant) throw new Error('Accepted workspace membership was not created');
      this.db.exec('COMMIT');
      return tenant;
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
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

  personalDotResetEligibility(tenantId: string, userId: string): PersonalDotResetResult {
    const row = this.db.prepare(`SELECT t.kind,m.role,
      (SELECT COUNT(*) FROM memberships members WHERE members.tenant_id=t.id) AS member_count
      FROM tenants t JOIN memberships m ON m.tenant_id=t.id AND m.user_id=? WHERE t.id=?`)
      .get(userId, tenantId) as { kind: string; role: string; member_count: number } | undefined;
    if (!row) return 'not-found';
    if (row.kind !== 'personal') return 'not-personal';
    if (row.role !== 'owner') return 'not-owner';
    if (row.member_count !== 1) return 'shared';
    return 'ok';
  }

  resetPersonalDot(tenantId: string, userId: string): PersonalDotResetResult {
    const eligibility = this.personalDotResetEligibility(tenantId, userId);
    if (eligibility !== 'ok') return eligibility;
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const lockedEligibility = this.personalDotResetEligibility(tenantId, userId);
      if (lockedEligibility !== 'ok') { this.db.exec('COMMIT'); return lockedEligibility; }
      this.db.prepare('DELETE FROM slack_oauth_flows WHERE tenant_id=?').run(tenantId);
      this.db.prepare('DELETE FROM slack_installations WHERE tenant_id=?').run(tenantId);
      this.db.prepare('DELETE FROM website_sign_in_requests WHERE tenant_id=?').run(tenantId);
      this.db.prepare('DELETE FROM page_action_approvals WHERE tenant_id=?').run(tenantId);
      this.db.prepare('DELETE FROM dot_pause_tasks WHERE tenant_id=?').run(tenantId);
      this.db.prepare('DELETE FROM task_attachments WHERE tenant_id=?').run(tenantId);
      this.db.prepare('DELETE FROM entries WHERE tenant_id=?').run(tenantId);
      this.db.prepare('DELETE FROM tasks WHERE tenant_id=?').run(tenantId);
      this.db.prepare('DELETE FROM watches WHERE tenant_id=?').run(tenantId);
      this.db.prepare('DELETE FROM voice_calls WHERE tenant_id=?').run(tenantId);
      this.db.prepare('DELETE FROM tenant_memories WHERE tenant_id=?').run(tenantId);
      this.db.prepare('DELETE FROM personal_dot_memories WHERE user_id=?').run(userId);
      this.db.prepare('DELETE FROM workspace_pages WHERE tenant_id=?').run(tenantId);
      this.db.prepare('DELETE FROM tenant_action_rules WHERE tenant_id=?').run(tenantId);
      this.db.prepare('DELETE FROM workspace_invitations WHERE tenant_id=?').run(tenantId);
      // Provider configuration belongs to the local account setup, not the Dot's
      // conversations or memory. Keep the model endpoint/name and Keychain secret.
      this.db.prepare("DELETE FROM tenant_settings WHERE tenant_id=? AND key NOT IN ('modelBaseUrl','modelName')").run(tenantId);
      this.db.prepare(`UPDATE tenant_profiles SET name='Dot',shape='circle',color='#c8cbd5',eyes='dot',glasses='none',accessory='none',
        character='ring',pet='moss',avatar_setup_completed_at=NULL,onboarding_completed_at=NULL,onboarding_completed_name=NULL WHERE tenant_id=?`).run(tenantId);
      this.db.exec('COMMIT');
      return 'ok';
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  snapshot(configured: boolean, availableEngines: Engine[] = [], modelSettings: Snapshot['modelSettings'] = { baseUrl: '', model: '', hasKey: false }, tenantId = 'legacy'): Snapshot {
    const p = this.db.prepare('SELECT name,shape,color,eyes,glasses,accessory,character,pet,avatar_setup_completed_at AS avatarSetupCompletedAt,onboarding_completed_at AS onboardingCompletedAt,onboarding_completed_name AS onboardingCompletedName FROM tenant_profiles WHERE tenant_id=?').get(tenantId) as Snapshot['profile'] | undefined;
    if (!p) throw new Error('Workspace profile is missing');
    const reasoningEffort = this.getSetting('reasoningEffort', tenantId);
    return {
      profile: p,
      dotPaused: this.isDotPaused(tenantId),
      preferences: {
        desktopNotifications: this.getSetting('desktopNotifications', tenantId) === 'true',
        reasoningEffort: isReasoningEffort(reasoningEffort) ? reasoningEffort : 'high',
      },
      computerAccess: {
        dotComputer: true,
        localComputer: this.getSetting('localComputerEnabled', tenantId) !== 'false',
        configured: this.getSetting('computerChoiceConfigured', tenantId) === 'true',
      },
      tasks: (this.db.prepare('SELECT * FROM tasks WHERE tenant_id=? ORDER BY priority DESC,created_at DESC').all(tenantId) as Record<string, unknown>[]).map(toTask),
      watches: (this.db.prepare('SELECT * FROM watches WHERE tenant_id=? ORDER BY rowid DESC').all(tenantId) as Record<string, unknown>[]).map(toWatch),
      entries: (this.db.prepare('SELECT id,tenant_id,task_id,kind,body,created_at,attachment_ids_json FROM entries WHERE tenant_id=? ORDER BY id DESC LIMIT 150').all(tenantId) as Record<string, unknown>[]).map(row => {
        const entry = toEntry(row);
        let ids: string[] = [];
        try { ids = JSON.parse(String(row.attachment_ids_json || '[]')) as string[]; } catch { /* Old malformed rows have no attachments. */ }
        return { ...entry, attachments: this.attachmentSummaries(ids, tenantId) };
      }).reverse(),
      configured, availableEngines, modelSettings,
    };
  }

  createVoiceCall(tenantId: string, userId: string, now = new Date().toISOString()): VoiceCallSession {
    const id = randomUUID();
    this.db.prepare('INSERT INTO voice_calls(id,tenant_id,user_id,started_at) VALUES (?,?,?,?)').run(id, tenantId, userId, now);
    return { id, tenantId, startedAt: now, endedAt: null, durationSeconds: null };
  }

  endVoiceCall(tenantId: string, userId: string, id: string, durationSeconds: number, now = new Date().toISOString()): VoiceCallSession | null {
    this.db.prepare('UPDATE voice_calls SET ended_at=?,duration_seconds=? WHERE id=? AND tenant_id=? AND user_id=? AND ended_at IS NULL')
      .run(now, durationSeconds, id, tenantId, userId);
    const row = this.db.prepare('SELECT id,tenant_id,started_at,ended_at,duration_seconds FROM voice_calls WHERE id=? AND tenant_id=? AND user_id=?')
      .get(id, tenantId, userId) as { id: string; tenant_id: string; started_at: string; ended_at: string | null; duration_seconds: number | null } | undefined;
    return row ? { id: row.id, tenantId: row.tenant_id, startedAt: row.started_at, endedAt: row.ended_at, durationSeconds: row.duration_seconds } : null;
  }

  voiceCalls(tenantId: string, userId: string, limit = 50): VoiceCallSession[] {
    const rows = this.db.prepare('SELECT id,tenant_id,started_at,ended_at,duration_seconds FROM voice_calls WHERE tenant_id=? AND user_id=? ORDER BY started_at DESC LIMIT ?')
      .all(tenantId, userId, limit) as { id: string; tenant_id: string; started_at: string; ended_at: string | null; duration_seconds: number | null }[];
    return rows.map(row => ({ id: row.id, tenantId: row.tenant_id, startedAt: row.started_at, endedAt: row.ended_at, durationSeconds: row.duration_seconds }));
  }

  activityPage(tenantId: string, beforeId: number | null = null, limit = 50): { entries: Entry[]; nextCursor: number | null } {
    const boundedLimit = Math.max(1, Math.min(100, Math.floor(limit)));
    const rows = this.db.prepare(`SELECT id,tenant_id,task_id,kind,body,created_at FROM entries
      WHERE tenant_id=? AND (? IS NULL OR id<?) ORDER BY id DESC LIMIT ?`)
      .all(tenantId, beforeId, beforeId, boundedLimit + 1) as Record<string, unknown>[];
    const page = rows.slice(0, boundedLimit).map(toEntry);
    return { entries: page, nextCursor: rows.length > boundedLimit ? page.at(-1)?.id ?? null : null };
  }

  tenantMemories(tenantId: string): TenantMemory[] {
    return this.db.prepare(`SELECT m.id,m.tenant_id AS tenantId,m.note,m.created_by AS createdBy,u.name AS createdByName,m.created_at AS createdAt,m.updated_at AS updatedAt
      FROM tenant_memories m JOIN users u ON u.id=m.created_by WHERE m.tenant_id=? ORDER BY m.created_at DESC,m.id DESC`)
      .all(tenantId) as unknown as TenantMemory[];
  }

  addTenantMemory(tenantId: string, createdBy: string, note: string): TenantMemory {
    const normalized = note.trim();
    if (!normalized || normalized.length > 1000) throw new Error('Invalid memory note');
    const id = randomUUID();
    const now = new Date().toISOString();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const count = this.db.prepare('SELECT COUNT(*) AS count FROM tenant_memories WHERE tenant_id=?').get(tenantId) as { count: number };
      if (count.count >= 20) throw new Error('工作区最多保存 20 条记忆');
      this.db.prepare('INSERT INTO tenant_memories(id,tenant_id,created_by,note,created_at,updated_at) VALUES (?,?,?,?,?,?)')
        .run(id, tenantId, createdBy, normalized, now, now);
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
    return this.tenantMemories(tenantId).find(memory => memory.id === id)!;
  }

  updateTenantMemory(tenantId: string, id: string, actorUserId: string, note: string): TenantMemory | null | 'forbidden' {
    const normalized = note.trim();
    if (!normalized || normalized.length > 1000) throw new Error('Invalid memory note');
    const memory = this.db.prepare('SELECT created_by FROM tenant_memories WHERE tenant_id=? AND id=?').get(tenantId, id) as { created_by: string } | undefined;
    if (!memory) return null;
    if (!this.canManageTenantMemory(tenantId, actorUserId, memory.created_by)) return 'forbidden';
    this.db.prepare('UPDATE tenant_memories SET note=?,updated_at=? WHERE tenant_id=? AND id=?')
      .run(normalized, new Date().toISOString(), tenantId, id);
    return this.tenantMemories(tenantId).find(item => item.id === id)!;
  }

  deleteTenantMemory(tenantId: string, id: string, actorUserId: string): boolean | 'forbidden' {
    const memory = this.db.prepare('SELECT created_by FROM tenant_memories WHERE tenant_id=? AND id=?').get(tenantId, id) as { created_by: string } | undefined;
    if (!memory) return false;
    if (!this.canManageTenantMemory(tenantId, actorUserId, memory.created_by)) return 'forbidden';
    this.db.prepare('DELETE FROM tenant_memories WHERE tenant_id=? AND id=?').run(tenantId, id);
    return true;
  }

  personalDotMemories(userId: string): PersonalDotMemory[] {
    return this.db.prepare(`SELECT id,note,source_task_id AS sourceTaskId,created_at AS createdAt,updated_at AS updatedAt
      FROM personal_dot_memories WHERE user_id=? ORDER BY updated_at DESC,id DESC`).all(userId) as unknown as PersonalDotMemory[];
  }

  /** Private memory is available to an agent only while it works in the user's personal tenant. */
  personalDotMemoryContext(tenantId: string): { userId: string; memories: PersonalDotMemory[] } | null {
    const owners = this.db.prepare(`SELECT m.user_id AS userId FROM tenants t JOIN memberships m ON m.tenant_id=t.id
      WHERE t.id=? AND t.kind='personal'`).all(tenantId) as unknown as { userId: string }[];
    if (owners.length !== 1) return null;
    return { userId: owners[0].userId, memories: this.personalDotMemories(owners[0].userId) };
  }

  addPersonalDotMemory(userId: string, note: string): PersonalDotMemory {
    const normalized = normalizePersonalDotMemory(note);
    const id = randomUUID();
    const now = new Date().toISOString();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const count = this.db.prepare('SELECT COUNT(*) AS count FROM personal_dot_memories WHERE user_id=?').get(userId) as { count: number };
      if (count.count >= 20) throw new Error('每个 Dot 最多保存 20 条个人记忆');
      this.db.prepare('INSERT INTO personal_dot_memories(id,user_id,note,source_task_id,created_at,updated_at) VALUES (?,?,?,NULL,?,?)')
        .run(id, userId, normalized, now, now);
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
    return this.personalDotMemories(userId).find(memory => memory.id === id)!;
  }

  updatePersonalDotMemory(userId: string, id: string, note: string): PersonalDotMemory | null {
    const normalized = normalizePersonalDotMemory(note);
    const result = this.db.prepare('UPDATE personal_dot_memories SET note=?,updated_at=? WHERE user_id=? AND id=?')
      .run(normalized, new Date().toISOString(), userId, id);
    return Number(result.changes) ? this.personalDotMemories(userId).find(memory => memory.id === id) || null : null;
  }

  deletePersonalDotMemory(userId: string, id: string): boolean {
    return Number(this.db.prepare('DELETE FROM personal_dot_memories WHERE user_id=? AND id=?').run(userId, id).changes) > 0;
  }

  /** Apply model-proposed changes only to the one user's personal tenant and top-level task. */
  applyPersonalDotMemoryUpdates(tenantId: string, taskId: string, updates: PersonalDotMemoryUpdate[]): AppliedPersonalDotMemoryUpdate[] {
    if (!updates.length) return [];
    if (updates.length > 3) throw new Error('单次 Dot 记忆更新不能超过 3 条');
    const userId = this.personalDotMemoryContext(tenantId)?.userId;
    if (!userId) return [];
    const now = new Date().toISOString();
    const applied: AppliedPersonalDotMemoryUpdate[] = [];
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const task = this.db.prepare('SELECT status,parent_task_id AS parentTaskId,execution_mode AS executionMode FROM tasks WHERE tenant_id=? AND id=?')
        .get(tenantId, taskId) as { status: TaskStatus; parentTaskId: string | null; executionMode: string } | undefined;
      if (!task || task.status !== 'working' || task.parentTaskId || task.executionMode !== 'standard') {
        this.db.exec('COMMIT');
        return [];
      }
      for (const update of updates) {
        if (update.action === 'remember') {
          const note = normalizePersonalDotMemory(update.note);
          const duplicate = this.db.prepare('SELECT id FROM personal_dot_memories WHERE user_id=? AND lower(note)=lower(?)').get(userId, note) as { id: string } | undefined;
          if (duplicate) continue;
          const count = this.db.prepare('SELECT COUNT(*) AS count FROM personal_dot_memories WHERE user_id=?').get(userId) as { count: number };
          if (count.count >= 20) continue;
          const id = randomUUID();
          this.db.prepare('INSERT INTO personal_dot_memories(id,user_id,note,source_task_id,created_at,updated_at) VALUES (?,?,?,?,?,?)')
            .run(id, userId, note, taskId, now, now);
          applied.push({ action: update.action, id, note });
        } else if (update.action === 'update') {
          const note = normalizePersonalDotMemory(update.note);
          const existing = this.db.prepare('SELECT note FROM personal_dot_memories WHERE user_id=? AND id=?').get(userId, update.memoryId) as { note: string } | undefined;
          if (!existing || existing.note === note) continue;
          this.db.prepare('UPDATE personal_dot_memories SET note=?,source_task_id=?,updated_at=? WHERE user_id=? AND id=?')
            .run(note, taskId, now, userId, update.memoryId);
          applied.push({ action: update.action, id: update.memoryId, note });
        } else if (update.action === 'forget') {
          const existing = this.db.prepare('SELECT note FROM personal_dot_memories WHERE user_id=? AND id=?').get(userId, update.memoryId) as { note: string } | undefined;
          if (!existing) continue;
          this.db.prepare('DELETE FROM personal_dot_memories WHERE user_id=? AND id=?').run(userId, update.memoryId);
          applied.push({ action: update.action, id: update.memoryId, note: existing.note });
        }
      }
      this.db.exec('COMMIT');
      return applied;
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }

  private canManageTenantMemory(tenantId: string, actorUserId: string, createdBy: string) {
    if (createdBy === actorUserId) return true;
    return Boolean(this.db.prepare("SELECT 1 FROM memberships WHERE tenant_id=? AND user_id=? AND role IN ('owner','admin')").get(tenantId, actorUserId));
  }

  isWorkspaceAdmin(tenantId: string, actorUserId: string) {
    return Boolean(this.db.prepare("SELECT 1 FROM memberships WHERE tenant_id=? AND user_id=? AND role IN ('owner','admin')").get(tenantId, actorUserId));
  }

  isTenantMember(tenantId: string, userId: string) {
    return Boolean(this.db.prepare('SELECT 1 FROM memberships WHERE tenant_id=? AND user_id=?').get(tenantId, userId));
  }

  tenantActionRule(tenantId: string): TenantActionRule | null {
    const row = this.db.prepare(`SELECT id,tenant_id AS tenantId,scope,instruction,mode,created_by AS createdBy,created_at AS createdAt,updated_at AS updatedAt
      FROM tenant_action_rules WHERE tenant_id=? AND scope='scratchpad-write'`).get(tenantId) as (TenantActionRule & { createdBy: string }) | undefined;
    return row || null;
  }

  saveTenantActionRule(tenantId: string, actorUserId: string, instruction: string, mode: ActionRuleMode): TenantActionRule {
    const normalized = instruction.trim();
    if (!normalized || normalized.length > 1000) throw new Error('规则说明需为 1–1000 个字符');
    if (!['without-asking', 'when-requested', 'ask-before', 'hand-off'].includes(mode)) throw new Error('规则处理方式无效');
    if (!this.isWorkspaceAdmin(tenantId, actorUserId)) throw new Error('只有工作区所有者或管理员可以修改权限规则');
    const now = new Date().toISOString();
    const existing = this.db.prepare("SELECT id,created_by AS createdBy,created_at AS createdAt FROM tenant_action_rules WHERE tenant_id=? AND scope='scratchpad-write'")
      .get(tenantId) as { id: string; createdBy: string; createdAt: string } | undefined;
    if (existing) {
      this.db.prepare("UPDATE tenant_action_rules SET instruction=?,mode=?,updated_at=? WHERE tenant_id=? AND scope='scratchpad-write'")
        .run(normalized, mode, now, tenantId);
    } else {
      this.db.prepare('INSERT INTO tenant_action_rules(id,tenant_id,scope,instruction,mode,created_by,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)')
        .run(randomUUID(), tenantId, 'scratchpad-write', normalized, mode, actorUserId, now, now);
    }
    return this.tenantActionRule(tenantId)!;
  }

  deleteTenantActionRule(tenantId: string, actorUserId: string): boolean | 'forbidden' {
    if (!this.isWorkspaceAdmin(tenantId, actorUserId)) return 'forbidden';
    const result = this.db.prepare("DELETE FROM tenant_action_rules WHERE tenant_id=? AND scope='scratchpad-write'").run(tenantId);
    return Number(result.changes) > 0;
  }

  pageActionApproval(tenantId: string, taskId: string): PageActionApproval | null {
    const row = this.db.prepare(`SELECT id,tenant_id AS tenantId,task_id AS taskId,action_json,message,status,
      resume_status AS resumeStatus,next_run_at AS nextRunAt,created_at AS createdAt,decided_at AS decidedAt
      FROM page_action_approvals WHERE tenant_id=? AND task_id=? ORDER BY created_at DESC,id DESC LIMIT 1`).get(tenantId, taskId) as (Omit<PageActionApproval, 'action'> & { action_json: string }) | undefined;
    if (!row) return null;
    return { ...row, action: JSON.parse(row.action_json) as ScratchpadPageAction };
  }

  websiteSignInRequest(tenantId: string, taskId: string): WebsiteSignInRequest | null {
    const row = this.db.prepare(`SELECT id,tenant_id AS tenantId,task_id AS taskId,url,hostname,reason,status,created_at AS createdAt,updated_at AS updatedAt
      FROM website_sign_in_requests WHERE tenant_id=? AND task_id=? ORDER BY created_at DESC,id DESC LIMIT 1`).get(tenantId, taskId) as WebsiteSignInRequest | undefined;
    return row || null;
  }

  createWebsiteSignInRequest(tenantId: string, taskId: string, urlValue: string, reasonValue: string, sessionId: string | null = null): WebsiteSignInRequest {
    const url = new URL(urlValue);
    if (url.protocol !== 'https:' || !url.hostname || url.username || url.password || url.port || url.hash || url.search || url.href.length > 2048) throw new Error('网站登录只允许不含凭据、查询参数或锚点的标准 HTTPS 地址');
    const reason = reasonValue.trim();
    if (!reason || reason.length > 500) throw new Error('网站登录请求说明无效');
    const now = new Date().toISOString();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const task = this.getTask(taskId, tenantId);
      if (!task || task.status !== 'working') throw new Error('当前工作已不在请求网站登录的状态');
      this.db.prepare("UPDATE website_sign_in_requests SET status='cancelled',updated_at=? WHERE tenant_id=? AND task_id=? AND status IN ('pending','submitted')")
        .run(now, tenantId, taskId);
      const id = randomUUID();
      this.db.prepare(`INSERT INTO website_sign_in_requests(id,tenant_id,task_id,url,hostname,reason,status,created_at,updated_at)
        VALUES (?,?,?,?,?,?,'pending',?,?)`).run(id, tenantId, taskId, url.href, url.hostname, reason, now, now);
      this.db.prepare("UPDATE tasks SET status='waiting',next_run_at=NULL,error=NULL,agent_session_id=COALESCE(?,agent_session_id),updated_at=? WHERE tenant_id=? AND id=? AND status='working'")
        .run(sessionId, now, tenantId, taskId);
      this.db.prepare('INSERT INTO entries(tenant_id,task_id,kind,body,created_at) VALUES (?,?,?,?,?)')
        .run(tenantId, taskId, 'dot', `我需要登录 ${url.hostname} 才能继续。请使用下方的私密表单，或接管电脑手动登录。`, now);
      this.db.prepare('INSERT INTO entries(tenant_id,task_id,kind,body,created_at) VALUES (?,?,?,?,?)')
        .run(tenantId, taskId, 'system', `网站登录请求已创建：${url.hostname}。账号凭据只会发送到此工作区的电脑，不会进入任务记录。`, now);
      this.db.exec('COMMIT');
      return this.websiteSignInRequest(tenantId, taskId)!;
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }

  markWebsiteSignInSubmitted(tenantId: string, taskId: string): WebsiteSignInRequest | null {
    const now = new Date().toISOString();
    const task = this.getTask(taskId, tenantId);
    if (!task || task.status !== 'waiting') return null;
    const changed = this.db.prepare("UPDATE website_sign_in_requests SET status='submitted',updated_at=? WHERE tenant_id=? AND task_id=? AND status='pending'")
      .run(now, tenantId, taskId);
    if (!Number(changed.changes)) return null;
    this.db.prepare('INSERT INTO entries(tenant_id,task_id,kind,body,created_at) VALUES (?,?,?,?,?)')
      .run(tenantId, taskId, 'system', '用户已将登录信息填入工作区电脑；凭据未保存到任务记录。请在电脑页面完成登录或验证。', now);
    return this.websiteSignInRequest(tenantId, taskId);
  }

  cancelWebsiteSignInRequest(tenantId: string, taskId: string): WebsiteSignInRequest | null {
    const now = new Date().toISOString();
    const result = this.db.prepare("UPDATE website_sign_in_requests SET status='cancelled',updated_at=? WHERE tenant_id=? AND task_id=? AND status IN ('pending','submitted')")
      .run(now, tenantId, taskId);
    if (!Number(result.changes)) return null;
    this.db.prepare('INSERT INTO entries(tenant_id,task_id,kind,body,created_at) VALUES (?,?,?,?,?)')
      .run(tenantId, taskId, 'system', '用户取消了网站登录请求。', now);
    return this.websiteSignInRequest(tenantId, taskId);
  }

  continueWebsiteSignInTask(tenantId: string, taskId: string): Task | null {
    const now = new Date().toISOString();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const task = this.getTask(taskId, tenantId);
      const request = this.websiteSignInRequest(tenantId, taskId);
      if (!task || task.status !== 'waiting' || !request || !['pending', 'submitted'].includes(request.status)) throw new Error('没有可继续的网站登录请求');
      const instruction = `${task.instruction}\n\nUser confirmed: website sign-in was completed in the tenant computer. Continue with the requested task.`;
      this.db.prepare("UPDATE website_sign_in_requests SET status='continued',updated_at=? WHERE tenant_id=? AND task_id=? AND status IN ('pending','submitted')")
        .run(now, tenantId, taskId);
      this.db.prepare("UPDATE tasks SET instruction=?,status='queued',next_run_at=?,error=NULL,updated_at=? WHERE tenant_id=? AND id=? AND status='waiting'")
        .run(instruction, now, now, tenantId, taskId);
      this.db.prepare('INSERT INTO entries(tenant_id,task_id,kind,body,created_at) VALUES (?,?,?,?,?)')
        .run(tenantId, taskId, 'user', '我已在工作区电脑中完成登录，请继续。', now);
      this.db.exec('COMMIT');
      return this.getTask(taskId, tenantId);
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }

  requestPageActionApproval(tenantId: string, taskId: string, action: ScratchpadPageAction, message: string, resumeStatus: 'done' | 'scheduled', nextRunAt: string | null, sessionId: string | null = null): PageActionApproval {
    assertPageContent(action.title, action.content);
    if (action.action === 'update' && !/^[a-f0-9-]{36}$/i.test(action.pageId)) throw new Error('页面操作无效');
    if (action.action === 'update' && !this.tenantPage(tenantId, action.pageId)) throw new Error('找不到这个工作区里的 Scratchpad 页面');
    const now = new Date().toISOString();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const task = this.db.prepare('SELECT status FROM tasks WHERE tenant_id=? AND id=?').get(tenantId, taskId) as { status: TaskStatus } | undefined;
      if (!task || task.status !== 'working') throw new Error('当前工作已不在等待审批的状态');
      const id = randomUUID();
      this.db.prepare(`INSERT INTO page_action_approvals(id,tenant_id,task_id,action_json,message,status,resume_status,next_run_at,created_at)
        VALUES (?,?,?,?,?,'pending',?,?,?)`).run(id, tenantId, taskId, JSON.stringify(action), message.slice(0, 2000), resumeStatus, nextRunAt, now);
      this.db.prepare("UPDATE tasks SET status='waiting',next_run_at=NULL,error=NULL,agent_session_id=COALESCE(?,agent_session_id),updated_at=? WHERE tenant_id=? AND id=?")
        .run(sessionId, now, tenantId, taskId);
      const verb = action.action === 'create' ? '创建' : '更新';
      this.db.prepare('INSERT INTO entries(tenant_id,task_id,kind,body,created_at) VALUES (?,?,?,?,?)')
        .run(tenantId, taskId, 'dot', `我准备${verb} Scratchpad 页面「${action.title}」。内容尚未保存，请先查看下方提案并决定是否批准。`, now);
      this.db.prepare('INSERT INTO entries(tenant_id,task_id,kind,body,created_at) VALUES (?,?,?,?,?)')
        .run(tenantId, taskId, 'system', `Scratchpad 页面写入「${action.title}」等待审批；批准前没有修改页面。`, now);
      this.db.exec('COMMIT');
      return this.pageActionApproval(tenantId, taskId)!;
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }

  resolvePageActionApproval(tenantId: string, taskId: string, actorUserId: string, decision: 'approve' | 'decline'): { approval: PageActionApproval; page: WorkspacePage | null } | null {
    if (!this.isTenantMember(tenantId, actorUserId)) throw new Error('你不是该工作区成员');
    const now = new Date().toISOString();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const row = this.db.prepare(`SELECT id,action_json,message,resume_status AS resumeStatus,next_run_at AS nextRunAt
        FROM page_action_approvals WHERE tenant_id=? AND task_id=? AND status='pending' ORDER BY created_at DESC,id DESC LIMIT 1`)
        .get(tenantId, taskId) as { id: string; action_json: string; message: string; resumeStatus: 'done' | 'scheduled'; nextRunAt: string | null } | undefined;
      if (!row) { this.db.exec('ROLLBACK'); return null; }
      const task = this.db.prepare('SELECT status FROM tasks WHERE tenant_id=? AND id=?').get(tenantId, taskId) as { status: TaskStatus } | undefined;
      if (!task || task.status !== 'waiting') throw new Error('这项工作已不在等待审批状态');
      let page: WorkspacePage | null = null;
      let dotMessage: string;
      let result: string;
      if (decision === 'approve') {
        const action = JSON.parse(row.action_json) as ScratchpadPageAction;
        page = action.action === 'create'
          ? this.persistTenantPage(tenantId, action.title, action.content, null, taskId, now)
          : this.updateTenantPage(tenantId, action.pageId, action.title, action.content);
        if (!page) throw new Error('找不到这个工作区里的 Scratchpad 页面，页面没有被修改。');
        const verb = action.action === 'create' ? '创建' : '更新';
        dotMessage = `已按批准${verb} Scratchpad 页面「${page.title}」。${row.message ? `\n${row.message}` : ''}\n[[page:${page.id}|${encodeURIComponent(page.title)}]]`;
        result = `已按批准${verb} Scratchpad 页面「${page.title}」。${row.message}`;
      } else {
        dotMessage = '这次 Scratchpad 页面写入已拒绝，页面内容没有更改。';
        result = dotMessage;
      }
      this.db.prepare('UPDATE page_action_approvals SET status=?,decided_at=?,decided_by=? WHERE tenant_id=? AND id=? AND status=\'pending\'')
        .run(decision === 'approve' ? 'approved' : 'declined', now, actorUserId, tenantId, row.id);
      this.db.prepare('UPDATE tasks SET status=?,next_run_at=?,result=?,error=NULL,updated_at=? WHERE tenant_id=? AND id=?')
        .run(row.resumeStatus, row.resumeStatus === 'scheduled' ? row.nextRunAt : null, result, now, tenantId, taskId);
      this.db.prepare('INSERT INTO entries(tenant_id,task_id,kind,body,created_at) VALUES (?,?,?,?,?)').run(tenantId, taskId, 'dot', dotMessage, now);
      const audit = decision === 'approve' ? '用户批准了 Scratchpad 页面写入。' : '用户拒绝了 Scratchpad 页面写入；页面未更改。';
      this.db.prepare('INSERT INTO entries(tenant_id,task_id,kind,body,created_at) VALUES (?,?,?,?,?)').run(tenantId, taskId, 'system', audit, now);
      this.db.exec('COMMIT');
      return { approval: this.pageActionApproval(tenantId, taskId)!, page };
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }

  tenantPages(tenantId: string): WorkspacePage[] {
    return this.db.prepare(`SELECT p.id,p.tenant_id AS tenantId,p.title,p.content,p.created_by AS createdBy,
      u.name AS createdByName,p.source_task_id AS sourceTaskId,p.created_at AS createdAt,p.updated_at AS updatedAt
      FROM workspace_pages p LEFT JOIN users u ON u.id=p.created_by WHERE p.tenant_id=? ORDER BY p.updated_at DESC,p.id DESC`)
      .all(tenantId) as unknown as WorkspacePage[];
  }

  tenantPage(tenantId: string, id: string): WorkspacePage | null {
    const row = this.db.prepare(`SELECT p.id,p.tenant_id AS tenantId,p.title,p.content,p.created_by AS createdBy,
      u.name AS createdByName,p.source_task_id AS sourceTaskId,p.created_at AS createdAt,p.updated_at AS updatedAt
      FROM workspace_pages p LEFT JOIN users u ON u.id=p.created_by WHERE p.tenant_id=? AND p.id=?`).get(tenantId, id) as WorkspacePage | undefined;
    return row || null;
  }

  createTenantPage(tenantId: string, title: string, content: string, createdBy: string | null = null, sourceTaskId: string | null = null): WorkspacePage {
    const normalizedTitle = title.trim();
    const normalizedContent = content.trim();
    assertPageContent(normalizedTitle, normalizedContent);
    const now = new Date().toISOString();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const page = this.persistTenantPage(tenantId, normalizedTitle, normalizedContent, createdBy, sourceTaskId, now);
      this.db.exec('COMMIT');
      return page;
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }

  updateTenantPage(tenantId: string, id: string, title: string, content: string): WorkspacePage | null {
    const normalizedTitle = title.trim();
    const normalizedContent = content.trim();
    assertPageContent(normalizedTitle, normalizedContent);
    const updatedAt = new Date().toISOString();
    const result = this.db.prepare('UPDATE workspace_pages SET title=?,content=?,updated_at=? WHERE tenant_id=? AND id=?')
      .run(normalizedTitle, normalizedContent, updatedAt, tenantId, id);
    return Number(result.changes) ? this.tenantPage(tenantId, id) : null;
  }

  private persistTenantPage(tenantId: string, title: string, content: string, createdBy: string | null, sourceTaskId: string | null, now: string): WorkspacePage {
    if (sourceTaskId) {
      const existing = this.db.prepare('SELECT id FROM workspace_pages WHERE tenant_id=? AND source_task_id=?').get(tenantId, sourceTaskId) as { id: string } | undefined;
      if (existing) {
        this.db.prepare('UPDATE workspace_pages SET title=?,content=?,updated_at=? WHERE tenant_id=? AND id=?')
          .run(title, content, now, tenantId, existing.id);
        return this.tenantPage(tenantId, existing.id)!;
      }
    }
    const count = this.db.prepare('SELECT COUNT(*) AS count FROM workspace_pages WHERE tenant_id=?').get(tenantId) as { count: number };
    if (count.count >= 50) throw new Error('工作区最多保存 50 个 Scratchpad 页面');
    const id = randomUUID();
    this.db.prepare('INSERT INTO workspace_pages(id,tenant_id,title,content,created_by,source_task_id,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)')
      .run(id, tenantId, title, content, createdBy, sourceTaskId, now, now);
    return this.tenantPage(tenantId, id)!;
  }

  createTask(instruction: string, scheduleMinutes: number | null = null, engine: Engine = 'model', tenantId = 'legacy', scheduleSpec: ScheduleSpec | null = null, firstRunAt: string | null = null, attachmentIds: string[] = [], uploaderId = '', executionMode: Task['executionMode'] = 'standard', reasoningEffort: ReasoningEffort = 'high'): Task {
    const now = new Date().toISOString();
    const id = randomUUID();
    const title = instruction.trim().split(/[.!?。！？\n]/)[0].slice(0, 64) || '新任务';
    const taskSchedule = scheduleForTask(scheduleSpec, scheduleMinutes);
    const scheduleMinutesValue = taskSchedule?.frequency === 'interval' ? taskSchedule.intervalMinutes : null;
    if (attachmentIds.length > 5 || new Set(attachmentIds).size !== attachmentIds.length) throw new Error('附件数量或列表无效');
    this.db.exec('BEGIN IMMEDIATE');
    try {
      if (attachmentIds.length) {
        if (!uploaderId) throw new Error('上传附件的用户无效');
        const placeholders = attachmentIds.map(() => '?').join(',');
        const owned = this.db.prepare(`SELECT id FROM task_attachments WHERE tenant_id=? AND uploaded_by=? AND task_id IS NULL AND id IN (${placeholders})`).all(tenantId, uploaderId, ...attachmentIds) as { id: string }[];
        if (owned.length !== attachmentIds.length) throw new Error('一个或多个附件已失效或不属于当前工作区');
        const total = this.db.prepare(`SELECT COALESCE(SUM(size),0) AS total FROM task_attachments WHERE tenant_id=? AND uploaded_by=? AND task_id IS NULL AND id IN (${placeholders})`).get(tenantId, uploaderId, ...attachmentIds) as { total: number };
        if (total.total > 512 * 1024) throw new Error('附件总大小不能超过 512 KB');
      }
      this.db.prepare('INSERT INTO tasks (id,tenant_id,title,instruction,status,priority,next_run_at,schedule_minutes,result,error,created_at,updated_at,engine,reasoning_effort,agent_session_id,schedule_json,execution_mode) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .run(id, tenantId, title, instruction.trim(), 'queued', 0, firstRunAt || now, scheduleMinutesValue, null, null, now, now, engine, reasoningEffort, null, taskSchedule ? JSON.stringify(taskSchedule) : null, executionMode);
      if (attachmentIds.length) {
        const placeholders = attachmentIds.map(() => '?').join(',');
        this.db.prepare(`UPDATE task_attachments SET task_id=? WHERE tenant_id=? AND uploaded_by=? AND task_id IS NULL AND id IN (${placeholders})`)
          .run(id, tenantId, uploaderId, ...attachmentIds);
      }
      this.addEntry('user', instruction.trim(), id, tenantId, attachmentIds);
      this.addEntry('system', taskSchedule ? `已安排：${describeSchedule(taskSchedule)}。` : '已加入工作队列。', id, tenantId);
      this.db.exec('COMMIT');
      return this.getTask(id, tenantId)!;
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }

  addPendingAttachment(tenantId: string, uploaderId: string, name: string, mediaType: string, content: Uint8Array): AttachmentSummary {
    if (!content.byteLength || content.byteLength > 256 * 1024) throw new Error('单个文本附件不能超过 256 KB');
    const quota = this.db.prepare('SELECT COUNT(*) AS count,COALESCE(SUM(size),0) AS total FROM task_attachments WHERE tenant_id=? AND uploaded_by=? AND task_id IS NULL').get(tenantId, uploaderId) as { count: number; total: number };
    if (quota.count >= 5) throw new Error('一次任务最多添加 5 个附件');
    if (quota.total + content.byteLength > 512 * 1024) throw new Error('待发送附件总大小不能超过 512 KB');
    const id = randomUUID();
    const createdAt = new Date().toISOString();
    this.db.prepare('INSERT INTO task_attachments(id,tenant_id,uploaded_by,task_id,name,media_type,size,content,created_at) VALUES (?,?,?,?,?,?,?,?,?)')
      .run(id, tenantId, uploaderId, null, name, mediaType, content.byteLength, content, createdAt);
    return { id, name, mediaType, size: content.byteLength };
  }

  pendingAttachments(tenantId: string, uploaderId: string): AttachmentSummary[] {
    return this.db.prepare('SELECT id,name,media_type AS mediaType,size FROM task_attachments WHERE tenant_id=? AND uploaded_by=? AND task_id IS NULL ORDER BY created_at,id')
      .all(tenantId, uploaderId) as unknown as AttachmentSummary[];
  }

  deletePendingAttachment(tenantId: string, uploaderId: string, id: string): boolean {
    return Number(this.db.prepare('DELETE FROM task_attachments WHERE id=? AND tenant_id=? AND uploaded_by=? AND task_id IS NULL').run(id, tenantId, uploaderId).changes) === 1;
  }

  taskAttachments(taskId: string, tenantId: string): StoredTaskAttachment[] {
    return this.db.prepare('SELECT id,tenant_id AS tenantId,uploaded_by AS uploadedBy,task_id AS taskId,name,media_type AS mediaType,size,content,created_at AS createdAt FROM task_attachments WHERE task_id=? AND tenant_id=? ORDER BY created_at,id')
      .all(taskId, tenantId) as unknown as StoredTaskAttachment[];
  }

  private attachmentSummaries(ids: string[], tenantId: string): AttachmentSummary[] {
    if (!ids.length) return [];
    const placeholders = ids.map(() => '?').join(',');
    const rows = this.db.prepare(`SELECT id,name,media_type AS mediaType,size FROM task_attachments WHERE tenant_id=? AND task_id IS NOT NULL AND id IN (${placeholders})`).all(tenantId, ...ids) as unknown as AttachmentSummary[];
    const byId = new Map(rows.map(row => [row.id, row]));
    return ids.flatMap(id => byId.has(id) ? [byId.get(id)!] : []);
  }

  createDelegatedTasks(parentId: string, tenantId: string, delegations: { title: string; instruction: string; engine?: Engine }[], summaryMessage: string, sessionId?: string): Task[] {
    if (!Array.isArray(delegations) || delegations.length < 1 || delegations.length > 3) throw new Error('代理子任务数量无效');
    for (const child of delegations) {
      if (!child.title.trim() || child.title.trim().length > 120 || !child.instruction.trim() || child.instruction.trim().length > 5000) throw new Error('代理子任务内容无效');
      if (child.engine !== undefined && !['model', 'pi', 'dsh'].includes(child.engine)) throw new Error('代理子任务内核无效');
    }
    const now = new Date().toISOString();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const parent = this.getTask(parentId, tenantId);
      if (!parent || parent.status !== 'working' || parent.parentTaskId || scheduleForTask(parent.scheduleSpec, parent.scheduleMinutes)) throw new Error('当前工作不能委派子任务');
      if (this.delegatedTasks(parentId, tenantId).length) throw new Error('此工作已经委派过子任务');
      const children: Task[] = [];
      for (const delegated of delegations) {
        const id = randomUUID();
        const title = delegated.title.trim();
        const instruction = delegated.instruction.trim();
        this.db.prepare('INSERT INTO tasks(id,tenant_id,title,instruction,status,priority,next_run_at,schedule_minutes,result,error,created_at,updated_at,engine,reasoning_effort,agent_session_id,schedule_json,parent_task_id) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
          .run(id, tenantId, title, instruction, 'queued', parent.priority, now, null, null, null, now, now, delegated.engine || parent.engine, parent.reasoningEffort, null, null, parentId);
        this.db.prepare('INSERT INTO entries(tenant_id,task_id,kind,body,created_at) VALUES (?,?,?,?,?)')
          .run(tenantId, id, 'system', `由「${parent.title}」委派；结果将返回给主任务。`, now);
        children.push(this.getTask(id, tenantId)!);
      }
      this.db.prepare("UPDATE tasks SET status='delegating',result=?,next_run_at=NULL,error=NULL,agent_session_id=COALESCE(?,agent_session_id),updated_at=? WHERE tenant_id=? AND id=? AND status='working'")
        .run(summaryMessage.slice(0, 10000), sessionId || parent.agentSessionId, now, tenantId, parentId);
      this.db.prepare('INSERT INTO entries(tenant_id,task_id,kind,body,created_at) VALUES (?,?,?,?,?)')
        .run(tenantId, parentId, 'system', `已拆分为 ${children.length} 项并行子任务；可在 Activity 中分别查看或停止。`, now);
      this.db.exec('COMMIT');
      return children;
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }

  delegatedTasks(parentId: string, tenantId: string): Task[] {
    return (this.db.prepare('SELECT * FROM tasks WHERE tenant_id=? AND parent_task_id=? ORDER BY rowid').all(tenantId, parentId) as Record<string, unknown>[]).map(toTask);
  }

  releaseReadyDelegations(now = new Date().toISOString()): number {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const parents = this.db.prepare("SELECT id,tenant_id FROM tasks WHERE status='delegating'").all() as { id: string; tenant_id: string }[];
      let released = 0;
      for (const parent of parents) {
        const state = this.db.prepare("SELECT COUNT(*) AS total,SUM(CASE WHEN status IN ('done','failed','stopped') THEN 1 ELSE 0 END) AS terminal FROM tasks WHERE tenant_id=? AND parent_task_id=?")
          .get(parent.tenant_id, parent.id) as { total: number; terminal: number | null };
        if (!state.total || state.terminal !== state.total) continue;
        const changed = this.db.prepare("UPDATE tasks SET status='queued',next_run_at=?,updated_at=? WHERE tenant_id=? AND id=? AND status='delegating'")
          .run(now, now, parent.tenant_id, parent.id);
        if (!Number(changed.changes)) continue;
        const children = this.delegatedTasks(parent.id, parent.tenant_id);
        this.db.prepare('INSERT INTO entries(tenant_id,task_id,kind,body,created_at) VALUES (?,?,?,?,?)')
          .run(parent.tenant_id, parent.id, 'system', `所有 ${children.length} 项子任务均已结束；主任务正在汇总结果。`, now);
        released++;
      }
      this.db.exec('COMMIT');
      return released;
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
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

  updateTask(id: string, change: Partial<Pick<Task, 'status' | 'priority' | 'instruction' | 'nextRunAt' | 'result' | 'error' | 'scheduleMinutes' | 'scheduleSpec' | 'agentSessionId'>>, tenantId = 'legacy'): Task | null {
    const old = this.getTask(id, tenantId);
    if (!old) return null;
    const next = { ...old, ...change, updatedAt: new Date().toISOString() };
    this.db.prepare('UPDATE tasks SET instruction=?,status=?,priority=?,next_run_at=?,schedule_minutes=?,schedule_json=?,result=?,error=?,updated_at=?,agent_session_id=? WHERE tenant_id=? AND id=?')
      .run(next.instruction, next.status, next.priority, next.nextRunAt, next.scheduleMinutes, next.scheduleSpec ? JSON.stringify(next.scheduleSpec) : null, next.result, next.error, next.updatedAt, next.agentSessionId, tenantId, id);
    return this.getTask(id, tenantId);
  }

  stopTask(id: string, tenantId: string, actorUserId: string): { task: Task; cancelledApprovals: number } | null {
    if (!this.isTenantMember(tenantId, actorUserId)) throw new Error('你不是该工作区成员');
    const now = new Date().toISOString();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const task = this.getTask(id, tenantId);
      if (!task || ['done', 'failed', 'stopped'].includes(task.status)) { this.db.exec('ROLLBACK'); return null; }
      if (scheduleForTask(task.scheduleSpec, task.scheduleMinutes)) throw new Error('周期任务请在 Scheduled 中取消，以保留暂停与周期管理的独立状态');
      const updated = this.db.prepare("UPDATE tasks SET status='stopped',next_run_at=NULL,updated_at=? WHERE tenant_id=? AND id=? AND status IN ('queued','working','delegating','waiting','scheduled','paused')")
        .run(now, tenantId, id);
      if (!Number(updated.changes)) { this.db.exec('ROLLBACK'); return null; }
      const cancelled = this.db.prepare("UPDATE page_action_approvals SET status='cancelled',decided_at=?,decided_by=? WHERE tenant_id=? AND task_id=? AND status='pending'")
        .run(now, actorUserId, tenantId, id);
      const cancelledSignIn = this.db.prepare("UPDATE website_sign_in_requests SET status='cancelled',updated_at=? WHERE tenant_id=? AND task_id=? AND status IN ('pending','submitted')")
        .run(now, tenantId, id);
      this.db.prepare('INSERT INTO entries(tenant_id,task_id,kind,body,created_at) VALUES (?,?,?,?,?)')
        .run(tenantId, id, 'system', Number(cancelled.changes) ? '工作已停止；待批准的 Scratchpad 写入请求已取消，页面没有更改。' : Number(cancelledSignIn.changes) ? '工作已停止；网站登录请求已取消。' : '工作已由工作区成员停止。', now);
      this.db.exec('COMMIT');
      return { task: this.getTask(id, tenantId)!, cancelledApprovals: Number(cancelled.changes) };
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
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

  addEntry(kind: Entry['kind'], body: string, taskId: string | null = null, tenantId = 'legacy', attachmentIds: string[] = []): Entry {
    const now = new Date().toISOString();
    const result = this.db.prepare('INSERT INTO entries(tenant_id,task_id,kind,body,created_at,attachment_ids_json) VALUES (?,?,?,?,?,?)').run(tenantId, taskId, kind, body, now, JSON.stringify(attachmentIds));
    return { id: Number(result.lastInsertRowid), tenantId, taskId, kind, body, createdAt: now, attachments: this.attachmentSummaries(attachmentIds, tenantId) };
  }

  setProfile(name: string, shape: string, color: string, tenantId = 'legacy', eyes = 'dot', glasses = 'none', accessory = 'none', character = 'ring', pet = 'moss', completeSetup = false, completeOnboarding = false) {
    const setupAt = completeSetup || completeOnboarding ? new Date().toISOString() : null;
    const completedAt = completeOnboarding ? new Date().toISOString() : null;
    this.db.prepare('UPDATE tenant_profiles SET name=?,shape=?,color=?,eyes=?,glasses=?,accessory=?,character=?,pet=?,avatar_setup_completed_at=COALESCE(avatar_setup_completed_at,?),onboarding_completed_at=COALESCE(onboarding_completed_at,?),onboarding_completed_name=COALESCE(onboarding_completed_name,?) WHERE tenant_id=?')
      .run(name, shape, color, eyes, glasses, accessory, character, pet, setupAt, completedAt, completeOnboarding ? name : null, tenantId);
  }

  getProfile(tenantId = 'legacy') {
    const profile = this.db.prepare('SELECT name,shape,color,eyes,glasses,accessory,character,pet,avatar_setup_completed_at AS avatarSetupCompletedAt,onboarding_completed_at AS onboardingCompletedAt,onboarding_completed_name AS onboardingCompletedName FROM tenant_profiles WHERE tenant_id=?').get(tenantId) as Snapshot['profile'] | undefined;
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

  isDotPaused(tenantId = 'legacy') { return this.getSetting('dotPaused', tenantId) === 'true'; }

  pauseDot(tenantId: string, activeTaskIds: string[]): string[] {
    if (this.isDotPaused(tenantId)) return [];
    const now = new Date().toISOString();
    const paused: string[] = [];
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.setSetting('dotPaused', 'true', tenantId);
      for (const taskId of new Set(activeTaskIds)) {
        const task = this.db.prepare('SELECT status,next_run_at FROM tasks WHERE tenant_id=? AND id=?').get(tenantId, taskId) as { status: string; next_run_at: string | null } | undefined;
        if (task?.status !== 'working') continue;
        const changed = this.db.prepare("UPDATE tasks SET status='paused',next_run_at=NULL,updated_at=? WHERE tenant_id=? AND id=? AND status='working'").run(now, tenantId, taskId);
        if (!Number(changed.changes)) continue;
        this.db.prepare('INSERT OR REPLACE INTO dot_pause_tasks(tenant_id,task_id,next_run_at) VALUES (?,?,?)').run(tenantId, taskId, task.next_run_at);
        this.db.prepare('INSERT INTO entries(tenant_id,task_id,kind,body,created_at) VALUES (?,?,?,?,?)')
          .run(tenantId, taskId, 'system', 'Dot 已暂停；恢复后会继续这项工作。', now);
        paused.push(taskId);
      }
      this.db.exec('COMMIT');
      return paused;
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }

  resumeDot(tenantId: string): string[] {
    const now = new Date().toISOString();
    const resumed: string[] = [];
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.setSetting('dotPaused', 'false', tenantId);
      const rows = this.db.prepare('SELECT task_id,next_run_at FROM dot_pause_tasks WHERE tenant_id=?').all(tenantId) as { task_id: string; next_run_at: string | null }[];
      for (const row of rows) {
        const task = this.getTask(row.task_id, tenantId);
        if (task?.status === 'paused') {
          const recurring = Boolean(task.scheduleSpec || task.scheduleMinutes);
          const status = recurring ? 'scheduled' : 'queued';
          this.db.prepare('UPDATE tasks SET status=?,next_run_at=?,error=NULL,updated_at=? WHERE tenant_id=? AND id=? AND status=\'paused\'')
            .run(status, row.next_run_at || now, now, tenantId, row.task_id);
          this.db.prepare('INSERT INTO entries(tenant_id,task_id,kind,body,created_at) VALUES (?,?,?,?,?)')
            .run(tenantId, row.task_id, 'system', 'Dot 已恢复，这项工作已重新排入队列。', now);
          resumed.push(row.task_id);
        }
      }
      this.db.prepare('DELETE FROM dot_pause_tasks WHERE tenant_id=?').run(tenantId);
      this.db.exec('COMMIT');
      return resumed;
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }

  forgetDotPausedTask(tenantId: string, taskId: string) {
    this.db.prepare('DELETE FROM dot_pause_tasks WHERE tenant_id=? AND task_id=?').run(tenantId, taskId);
  }

  createWatch(url: string, intervalMinutes: number, tenantId = 'legacy'): Watch {
    const id = randomUUID();
    this.db.prepare('INSERT INTO watches(id,tenant_id,url,interval_minutes,status,next_check_at,last_checked_at,last_hash,last_status,error,last_content,last_task_id) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)')
      .run(id, tenantId, url, intervalMinutes, 'active', new Date().toISOString(), null, null, null, null, null, null);
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

  recordWatchResponse(id: string, tenantId: string, digest: string, content: string, checkedAt: string, nextCheckAt: string): { outcome: 'ignored' | 'baseline' | 'unchanged' | 'changed'; task: Task | null } {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const watch = this.db.prepare('SELECT url,status,last_hash,last_content FROM watches WHERE tenant_id=? AND id=?').get(tenantId, id) as { url: string; status: Watch['status']; last_hash: string | null; last_content: string | null } | undefined;
      if (!watch || watch.status !== 'active') {
        this.db.exec('COMMIT');
        return { outcome: 'ignored', task: null };
      }
      if (watch.last_hash === digest) {
        this.db.prepare("UPDATE watches SET last_checked_at=?,next_check_at=?,last_status='没有变化',error=NULL WHERE tenant_id=? AND id=?")
          .run(checkedAt, nextCheckAt, tenantId, id);
        this.db.exec('COMMIT');
        return { outcome: 'unchanged', task: null };
      }
      if (!watch.last_hash) {
        this.db.prepare("UPDATE watches SET last_hash=?,last_content=?,last_checked_at=?,next_check_at=?,last_status='已建立基线',error=NULL WHERE tenant_id=? AND id=?")
          .run(digest, content, checkedAt, nextCheckAt, tenantId, id);
        this.db.exec('COMMIT');
        return { outcome: 'baseline', task: null };
      }

      const sourceHost = new URL(watch.url).hostname;
      const instruction = `Review page update: ${sourceHost}. Compare the saved page snapshots and report substantive changes only. This is a read-only review; do not modify pages, files, accounts, or other sources.`;
      const context = JSON.stringify({ sourceUrl: watch.url, previousText: watch.last_content || '', currentText: content });
      const taskId = randomUUID();
      const title = instruction.split(/[.!?。！？\n]/)[0].slice(0, 64) || 'Page update review';
      this.db.prepare('INSERT INTO tasks (id,tenant_id,title,instruction,status,priority,next_run_at,schedule_minutes,result,error,created_at,updated_at,engine,agent_session_id,schedule_json,execution_mode,task_context) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
        .run(taskId, tenantId, title, instruction, 'queued', 0, checkedAt, null, null, null, checkedAt, checkedAt, 'model', null, null, 'read-only', context);
      this.db.prepare("INSERT INTO entries(tenant_id,task_id,kind,body,created_at,attachment_ids_json) VALUES (?,?,?,?,?, '[]')")
        .run(tenantId, taskId, 'user', `A monitored page changed: ${watch.url}. Compare its previous and current text and report what matters.`, checkedAt);
      this.db.prepare("INSERT INTO entries(tenant_id,task_id,kind,body,created_at,attachment_ids_json) VALUES (?,?,?,?,?, '[]')")
        .run(tenantId, taskId, 'system', 'A read-only page-change review was added to the work queue.', checkedAt);
      this.db.prepare("UPDATE watches SET last_hash=?,last_content=?,last_checked_at=?,next_check_at=?,last_status='内容有变化，已启动只读分析',last_task_id=?,error=NULL WHERE tenant_id=? AND id=?")
        .run(digest, content, checkedAt, nextCheckAt, taskId, tenantId, id);
      this.db.exec('COMMIT');
      return { outcome: 'changed', task: this.getTask(taskId, tenantId)! };
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }

  taskContext(id: string, tenantId = 'legacy'): string {
    const row = this.db.prepare('SELECT task_context FROM tasks WHERE tenant_id=? AND id=?').get(tenantId, id) as { task_context: string } | undefined;
    return row?.task_context || '';
  }
}

function toTask(r: Record<string, unknown>): Task {
  const scheduleMinutes = r.schedule_minutes == null ? null : Number(r.schedule_minutes);
  let scheduleSpec: ScheduleSpec | null = null;
  if (typeof r.schedule_json === 'string') {
    try { scheduleSpec = validateScheduleSpec(JSON.parse(r.schedule_json)); } catch { scheduleSpec = null; }
  }
  scheduleSpec = scheduleForTask(scheduleSpec, scheduleMinutes);
  return {
    id: String(r.id), tenantId: String(r.tenant_id), parentTaskId: r.parent_task_id == null ? null : String(r.parent_task_id), title: String(r.title), instruction: String(r.instruction),
    executionMode: r.execution_mode === 'read-only' ? 'read-only' : 'standard',
    engine: r.engine as Engine, reasoningEffort: isReasoningEffort(r.reasoning_effort) ? r.reasoning_effort : 'high', agentSessionId: r.agent_session_id == null ? null : String(r.agent_session_id),
    status: r.status as TaskStatus, priority: Number(r.priority),
    nextRunAt: r.next_run_at == null ? null : String(r.next_run_at),
    scheduleMinutes: scheduleMinutes !== null ? scheduleMinutes : scheduleSpec?.frequency === 'interval' ? scheduleSpec.intervalMinutes : null,
    scheduleSpec,
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
    lastStatus: r.last_status == null ? null : String(r.last_status), lastTaskId: r.last_task_id == null ? null : String(r.last_task_id),
    error: r.error == null ? null : String(r.error),
  };
}

function assertPageContent(title: string, content: string) {
  if (!title || title.length > 120 || !content || content.length > 24000) throw new Error('页面标题需为 1–120 个字符，正文需为 1–24000 个字符');
}

function normalizePersonalDotMemory(note: string) {
  const normalized = String(note).trim();
  if (!normalized || normalized.length > 1000) throw new Error('个人记忆需为 1–1000 个字符');
  return normalized;
}

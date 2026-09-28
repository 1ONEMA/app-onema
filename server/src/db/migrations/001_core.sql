-- 001_core: identidade, sessões, auditoria, idempotência, avisos in-app
-- Timestamps em UTC (ISO-8601). IDs opacos (UUID v4).

CREATE TABLE users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE COLLATE NOCASE,
  name TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','DISABLED')),
  academy_eligible INTEGER NOT NULL DEFAULT 0 CHECK (academy_eligible IN (0,1)),
  mfa_secret TEXT,
  mfa_enabled INTEGER NOT NULL DEFAULT 0 CHECK (mfa_enabled IN (0,1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE user_roles (
  user_id TEXT NOT NULL REFERENCES users(id),
  role TEXT NOT NULL CHECK (role IN (
    'PACIENTE','ESPECIALISTA','SUPORTE_ACADEMY','GESTOR_CONTEUDO','AVALIADOR_RT',
    'ADMIN_ACADEMY','CREDENCIAMENTO','FINANCEIRO','AUDITOR','OPERADOR_CENTRAL','ADMIN_PRIME')),
  granted_by TEXT,
  granted_at TEXT NOT NULL,
  PRIMARY KEY (user_id, role)
);

CREATE TABLE sessions (
  id_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  csrf_token TEXT NOT NULL,
  mfa_verified INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  revoked_at TEXT
);
CREATE INDEX idx_sessions_user ON sessions(user_id);

CREATE TABLE password_resets (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  used_at TEXT
);

-- Fila de saída de mensagens. Sem provedor configurado, as mensagens ficam com
-- status NAO_ENVIADO_SEM_PROVEDOR (nunca são apresentadas como enviadas).
CREATE TABLE outbox_messages (
  id TEXT PRIMARY KEY,
  channel TEXT NOT NULL,
  purpose TEXT NOT NULL,
  recipient_user_id TEXT,
  recipient_address TEXT,
  template TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL
);

-- Avisos in-app (canal "Aplicativo") gerados por eventos reais.
CREATE TABLE notifications (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  purpose TEXT NOT NULL CHECK (purpose IN ('ESSENCIAL','LEMBRETE','RESUMO','OFERTA')),
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  created_at TEXT NOT NULL,
  read_at TEXT
);
CREATE INDEX idx_notifications_user ON notifications(user_id, created_at);

CREATE TABLE idempotency_keys (
  user_id TEXT NOT NULL,
  key TEXT NOT NULL,
  route TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  status_code INTEGER,
  response_json TEXT,
  created_at TEXT NOT NULL,
  PRIMARY KEY (user_id, key)
);

-- Trilha append-only. UPDATE e DELETE são bloqueados por trigger (ACA-T028).
CREATE TABLE audit_events (
  id TEXT PRIMARY KEY,
  seq INTEGER NOT NULL UNIQUE,
  actor_id TEXT,
  action TEXT NOT NULL,
  subject_type TEXT NOT NULL,
  subject_id TEXT,
  before_hash TEXT,
  after_hash TEXT,
  correlation_id TEXT,
  meta_json TEXT,
  occurred_at TEXT NOT NULL
);
CREATE INDEX idx_audit_subject ON audit_events(subject_type, subject_id);
CREATE INDEX idx_audit_actor ON audit_events(actor_id);
CREATE TRIGGER audit_no_update BEFORE UPDATE ON audit_events
BEGIN SELECT RAISE(ABORT, 'audit_events is append-only'); END;
CREATE TRIGGER audit_no_delete BEFORE DELETE ON audit_events
BEGIN SELECT RAISE(ABORT, 'audit_events is append-only'); END;

CREATE TABLE support_tickets (
  id TEXT PRIMARY KEY,
  subject_user_id TEXT NOT NULL REFERENCES users(id),
  opened_by TEXT NOT NULL REFERENCES users(id),
  category TEXT NOT NULL,
  description TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'ABERTO' CHECK (status IN ('ABERTO','ENCERRADO')),
  created_at TEXT NOT NULL,
  closed_at TEXT
);

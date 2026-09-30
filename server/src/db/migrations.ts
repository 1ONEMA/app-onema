/* Migrations PostgreSQL (embutidas para empacotamento nas Netlify Functions). Somente aditivas. */
export const MIGRATIONS: { name: string; sql: string }[] = [
  { name: '001_core', sql: `
CREATE OR REPLACE FUNCTION onema_forbid() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN RAISE EXCEPTION '%', TG_ARGV[0] USING ERRCODE = 'P0001'; END $fn$;

-- 001_core: identidade, sessões, auditoria, idempotência, avisos in-app
-- Timestamps em UTC (ISO-8601). IDs opacos (UUID v4).

CREATE TABLE users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE CHECK (email = lower(email)),
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
  seq BIGINT GENERATED ALWAYS AS IDENTITY UNIQUE,
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
CREATE TRIGGER audit_no_update BEFORE UPDATE ON audit_events FOR EACH ROW EXECUTE FUNCTION onema_forbid('audit_events is append-only');
CREATE TRIGGER audit_no_delete BEFORE DELETE ON audit_events FOR EACH ROW EXECUTE FUNCTION onema_forbid('audit_events is append-only');

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

-- Limite de requisições compartilhado entre instâncias (funções serverless)
CREATE TABLE rate_limits (
  key TEXT PRIMARY KEY,
  window_start BIGINT NOT NULL,
  count INTEGER NOT NULL
);
` },
  { name: '002_academy', sql: `
-- 002_academy: ONEMA Academy (Documento Mestre de Transferência Técnica v1.0, seções 5-11)
-- Domínio educacional do parceiro. Nenhuma tabela aqui referencia paciente,
-- prontuário ou Carteira Digital (segregação - ACA-T003/ACA-T038).

CREATE TABLE academy_courses (
  id TEXT PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,              -- C01..C04
  sort_order INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','INACTIVE')),
  current_version_id TEXT,                -- versão PUBLICADA vigente para novas vinculações
  created_at TEXT NOT NULL
);

CREATE TABLE academy_course_versions (
  id TEXT PRIMARY KEY,
  course_id TEXT NOT NULL REFERENCES academy_courses(id),
  version INTEGER NOT NULL,
  title TEXT NOT NULL,
  objectives TEXT,
  -- 1 = obrigatória, 0 = não obrigatória, NULL = pendente de definição
  activity_required INTEGER CHECK (activity_required IN (0,1)),
  workload_text TEXT,                     -- carga horária: NULL = [VALIDAR] (P-005)
  source_note TEXT,
  state TEXT NOT NULL DEFAULT 'DRAFT' CHECK (state IN ('DRAFT','IN_REVIEW','APPROVED','PUBLISHED','ARCHIVED')),
  created_by TEXT,
  created_at TEXT NOT NULL,
  submitted_at TEXT,
  approved_by TEXT,
  approved_at TEXT,
  published_at TEXT,
  content_hash TEXT,
  UNIQUE (course_id, version)
);

CREATE TABLE academy_media_assets (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('VIDEO','AUDIO','CAPTION','TRANSCRIPT','IMAGE')),
  title TEXT NOT NULL,
  filename TEXT NOT NULL,
  storage_key TEXT NOT NULL,
  mime TEXT NOT NULL,
  size_bytes INTEGER NOT NULL,
  checksum_sha256 TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'PENDING' CHECK (state IN ('PENDING','APPROVED','BLOCKED')),
  created_by TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE academy_lessons (
  id TEXT PRIMARY KEY,
  course_version_id TEXT NOT NULL REFERENCES academy_course_versions(id),
  code TEXT NOT NULL,                     -- C01-A01 ...
  sort_order INTEGER NOT NULL,
  required INTEGER NOT NULL DEFAULT 1,
  title TEXT NOT NULL,
  body TEXT,                              -- NULL = conteúdo pendente
  video_asset_id TEXT REFERENCES academy_media_assets(id),
  caption_asset_id TEXT REFERENCES academy_media_assets(id),
  transcript_asset_id TEXT REFERENCES academy_media_assets(id),
  completion_min_percent INTEGER CHECK (completion_min_percent BETWEEN 1 AND 100),
  UNIQUE (course_version_id, code)
);

CREATE TABLE academy_activities (
  id TEXT PRIMARY KEY,
  course_version_id TEXT NOT NULL REFERENCES academy_course_versions(id),
  version INTEGER NOT NULL,
  title TEXT NOT NULL,
  intro TEXT,
  required_correct INTEGER,               -- C01: 6 (seis decisões corretas após revisão)
  source_note TEXT,
  state TEXT NOT NULL DEFAULT 'DRAFT' CHECK (state IN ('DRAFT','APPROVED','RETIRED')),
  created_by TEXT,
  created_at TEXT NOT NULL,
  approved_by TEXT,
  approved_at TEXT,
  UNIQUE (course_version_id, version)
);

CREATE TABLE academy_activity_steps (
  id TEXT PRIMARY KEY,
  activity_id TEXT NOT NULL REFERENCES academy_activities(id),
  sort_order INTEGER NOT NULL,
  prompt TEXT NOT NULL,
  options_json TEXT NOT NULL              -- [{id,text,correct,feedback}] - "correct" nunca vai ao cliente
);

CREATE TABLE academy_assessments (
  id TEXT PRIMARY KEY,
  course_version_id TEXT NOT NULL REFERENCES academy_course_versions(id),
  version INTEGER NOT NULL,
  question_count INTEGER,                 -- NULL = pendente
  pass_min_correct INTEGER,               -- NULL = pendente
  max_attempts INTEGER,                   -- NULL = pendente (C04: P-002)
  critical_gate INTEGER NOT NULL DEFAULT 0, -- 1 = questões críticas são gate independente da nota
  source_note TEXT,
  state TEXT NOT NULL DEFAULT 'DRAFT' CHECK (state IN ('DRAFT','APPROVED','RETIRED')),
  created_by TEXT,
  created_at TEXT NOT NULL,
  approved_by TEXT,
  approved_at TEXT,
  UNIQUE (course_version_id, version)
);

CREATE TABLE academy_questions (
  id TEXT PRIMARY KEY,                    -- questionVersionId
  assessment_id TEXT NOT NULL REFERENCES academy_assessments(id),
  position INTEGER NOT NULL,              -- número da questão (ex.: C04 críticas 03,06,08,10)
  critical INTEGER NOT NULL DEFAULT 0,
  stem TEXT NOT NULL,
  options_json TEXT NOT NULL,             -- [{id,text}]
  correct_option_id TEXT NOT NULL,        -- gabarito restrito: nunca exposto ao especialista
  created_by TEXT,
  created_at TEXT NOT NULL,
  UNIQUE (assessment_id, position)
);

CREATE TABLE academy_certificate_templates (
  id TEXT PRIMARY KEY,
  version INTEGER NOT NULL UNIQUE,
  heading TEXT NOT NULL,
  declaration TEXT NOT NULL,
  signatories_json TEXT NOT NULL,         -- [{name, role}]
  state TEXT NOT NULL DEFAULT 'DRAFT' CHECK (state IN ('DRAFT','APPROVED','RETIRED')),
  created_by TEXT,
  created_at TEXT NOT NULL,
  approved_by TEXT,
  approved_at TEXT
);

CREATE TABLE academy_enrollments (
  id TEXT PRIMARY KEY,
  partner_id TEXT NOT NULL REFERENCES users(id),
  journey_version TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('NAO_INICIADA','EM_ANDAMENTO','CONCLUIDA','SUSPENSA','CANCELADA')),
  started_at TEXT NOT NULL,
  completed_at TEXT
);
CREATE UNIQUE INDEX uq_enrollment_active ON academy_enrollments(partner_id) WHERE state <> 'CANCELADA';

-- Vínculo matrícula x versão do curso (congelado na primeira vinculação - ACA-T007)
CREATE TABLE academy_enrollment_courses (
  enrollment_id TEXT NOT NULL REFERENCES academy_enrollments(id),
  course_id TEXT NOT NULL REFERENCES academy_courses(id),
  course_version_id TEXT NOT NULL REFERENCES academy_course_versions(id),
  bound_at TEXT NOT NULL,
  result TEXT CHECK (result IN ('APROVADO','REPROVADO')),
  result_at TEXT,
  result_attempt_id TEXT,
  PRIMARY KEY (enrollment_id, course_id)
);

CREATE TABLE academy_lesson_progress (
  id TEXT PRIMARY KEY,
  enrollment_id TEXT NOT NULL REFERENCES academy_enrollments(id),
  lesson_id TEXT NOT NULL REFERENCES academy_lessons(id),
  state TEXT NOT NULL CHECK (state IN ('NAO_INICIADA','EM_ANDAMENTO','CONCLUIDA')),
  percent INTEGER NOT NULL DEFAULT 0,
  last_position INTEGER NOT NULL DEFAULT 0,
  row_version INTEGER NOT NULL DEFAULT 1,
  updated_at TEXT NOT NULL,
  completed_at TEXT,
  UNIQUE (enrollment_id, lesson_id)
);

CREATE TABLE academy_activity_attempts (
  id TEXT PRIMARY KEY,
  activity_id TEXT NOT NULL REFERENCES academy_activities(id),
  enrollment_id TEXT NOT NULL REFERENCES academy_enrollments(id),
  attempt_no INTEGER NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('EM_ANDAMENTO','CONCLUIDA','ABANDONADA')),
  started_at TEXT NOT NULL,
  completed_at TEXT,
  UNIQUE (activity_id, enrollment_id, attempt_no)
);
CREATE UNIQUE INDEX uq_activity_open ON academy_activity_attempts(activity_id, enrollment_id) WHERE state = 'EM_ANDAMENTO';

CREATE TABLE academy_activity_decisions (
  id TEXT PRIMARY KEY,
  attempt_id TEXT NOT NULL REFERENCES academy_activity_attempts(id),
  step_id TEXT NOT NULL REFERENCES academy_activity_steps(id),
  option_id TEXT NOT NULL,
  correct INTEGER NOT NULL,
  decided_at TEXT NOT NULL
);

CREATE TABLE academy_assessment_attempts (
  id TEXT PRIMARY KEY,
  assessment_id TEXT NOT NULL REFERENCES academy_assessments(id),
  enrollment_id TEXT NOT NULL REFERENCES academy_enrollments(id),
  attempt_no INTEGER NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('CRIADA','EM_ANDAMENTO','SUBMETIDA','APROVADA','REPROVADA','INVALIDADA')),
  question_order_json TEXT NOT NULL,
  started_at TEXT NOT NULL,
  submitted_at TEXT,
  correct_count INTEGER,
  critical_ok INTEGER,
  UNIQUE (assessment_id, enrollment_id, attempt_no)
);
CREATE UNIQUE INDEX uq_assessment_open ON academy_assessment_attempts(assessment_id, enrollment_id) WHERE state IN ('CRIADA','EM_ANDAMENTO');

CREATE TABLE academy_assessment_answers (
  id TEXT PRIMARY KEY,
  attempt_id TEXT NOT NULL REFERENCES academy_assessment_attempts(id),
  question_id TEXT NOT NULL REFERENCES academy_questions(id),
  option_id TEXT NOT NULL,
  correct INTEGER NOT NULL,
  UNIQUE (attempt_id, question_id)
);

CREATE TABLE academy_certificates (
  id TEXT PRIMARY KEY,
  enrollment_id TEXT NOT NULL UNIQUE REFERENCES academy_enrollments(id),
  public_code TEXT NOT NULL UNIQUE,
  template_id TEXT NOT NULL REFERENCES academy_certificate_templates(id),
  issued_at TEXT NOT NULL,
  snapshot_json TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  revoked_at TEXT,
  revoked_by TEXT,
  revoke_reason TEXT
);
CREATE OR REPLACE FUNCTION onema_cert_immutable() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  IF NEW.snapshot_json IS DISTINCT FROM OLD.snapshot_json OR NEW.content_hash IS DISTINCT FROM OLD.content_hash
     OR NEW.public_code IS DISTINCT FROM OLD.public_code OR NEW.issued_at IS DISTINCT FROM OLD.issued_at
     OR NEW.enrollment_id IS DISTINCT FROM OLD.enrollment_id THEN
    RAISE EXCEPTION 'certificate evidence is immutable' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END $fn$;
CREATE TRIGGER cert_immutable BEFORE UPDATE ON academy_certificates FOR EACH ROW EXECUTE FUNCTION onema_cert_immutable();
CREATE TRIGGER cert_no_delete BEFORE DELETE ON academy_certificates FOR EACH ROW EXECUTE FUNCTION onema_forbid('certificate evidence is immutable');

CREATE TABLE academy_certificate_verifications (
  id TEXT PRIMARY KEY,
  certificate_id TEXT,
  checked_at TEXT NOT NULL,
  result TEXT NOT NULL,
  request_fingerprint TEXT
);

CREATE TABLE academy_payment_orders (
  id TEXT PRIMARY KEY,
  partner_id TEXT NOT NULL REFERENCES users(id),
  amount_cents INTEGER NOT NULL,
  currency TEXT NOT NULL DEFAULT 'BRL',
  status TEXT NOT NULL CHECK (status IN ('PENDENTE','PAGO','RECUSADO','CANCELADO','ESTORNADO')),
  provider TEXT NOT NULL,
  provider_ref TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX uq_academy_order_open ON academy_payment_orders(partner_id) WHERE status IN ('PENDENTE','PAGO');

CREATE TABLE academy_payment_events (
  id TEXT PRIMARY KEY,
  provider_event_id TEXT NOT NULL UNIQUE,  -- replay protection (ACA-T006)
  order_id TEXT NOT NULL REFERENCES academy_payment_orders(id),
  type TEXT NOT NULL,
  received_at TEXT NOT NULL
);

CREATE TABLE partner_training_status (
  partner_id TEXT PRIMARY KEY REFERENCES users(id),
  journey_state TEXT NOT NULL,
  completed_at TEXT,
  credentialing_decision TEXT NOT NULL DEFAULT 'PENDENTE' CHECK (credentialing_decision IN ('PENDENTE','APTO','NAO_APTO')),
  decided_by TEXT,
  decided_at TEXT,
  decision_note TEXT,
  updated_at TEXT NOT NULL
);
` },
  { name: '003_prime', sql: `
-- 003_prime: ONEMA PRIME (Documento oficial de implantação v2.0 - decisão RT 28/09/2026)
-- Pagamentos exclusivamente simulados (SANDBOX) até liberação dos gates G6-G8.

CREATE TABLE prime_parameters (
  id TEXT PRIMARY KEY,
  version INTEGER NOT NULL UNIQUE,
  monthly_price_cents INTEGER NOT NULL,
  discount_bps INTEGER NOT NULL,           -- 500 = 5%
  discount_cap_cents INTEGER NOT NULL,     -- 2000 = R$ 20,00
  uses_per_cycle INTEGER NOT NULL,         -- 1
  retry_max INTEGER NOT NULL,              -- 3
  retry_window_days INTEGER NOT NULL,      -- 7
  refund_withdrawal_days INTEGER NOT NULL, -- 7 (direito de arrependimento)
  source_note TEXT,
  created_by TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE legal_texts (
  id TEXT PRIMARY KEY,
  code TEXT NOT NULL,                      -- T1, T2, T3-*
  version TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  rt_approved_at TEXT,
  legal_review TEXT NOT NULL DEFAULT 'PENDENTE' CHECK (legal_review IN ('PENDENTE','APROVADO')),
  created_at TEXT NOT NULL,
  UNIQUE (code, version)
);

CREATE TABLE provider_identity (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  legal_name TEXT,
  cnpj TEXT,
  address TEXT,
  support_channel TEXT,
  validated INTEGER NOT NULL DEFAULT 0,
  updated_by TEXT,
  updated_at TEXT
);

-- Catálogo ("Preços Oficiais v3" - não fornecido; gerenciado por ADMIN_PRIME).
CREATE TABLE catalog_items (
  id TEXT PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('SERVICO','PACOTE')),
  price_cents INTEGER NOT NULL CHECK (price_cents > 0),
  prime_eligible INTEGER NOT NULL DEFAULT 1,
  active INTEGER NOT NULL DEFAULT 1,
  valid_from TEXT,
  valid_to TEXT,
  is_demo INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE subscriptions (
  id TEXT PRIMARY KEY,
  patient_id TEXT NOT NULL REFERENCES users(id),
  status TEXT NOT NULL CHECK (status IN (
    'ASSINATURA_SOLICITADA','ACTIVE','PAYMENT_PENDING','SUSPENDED',
    'CANCEL_SCHEDULED','CANCELLED','REFUND_PENDING','REFUNDED')),
  parameters_id TEXT NOT NULL REFERENCES prime_parameters(id),
  terms_text_id TEXT NOT NULL REFERENCES legal_texts(id),
  privacy_text_id TEXT NOT NULL REFERENCES legal_texts(id),
  acceptance_json TEXT NOT NULL,           -- prova do aceite: versões, hashes, data, origem
  payment_method TEXT NOT NULL,
  protocol TEXT NOT NULL UNIQUE,
  accepted_at TEXT NOT NULL,
  activated_at TEXT,
  current_cycle_id TEXT,
  cancel_requested_at TEXT,
  cancel_protocol TEXT,
  ended_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX uq_subscription_open ON subscriptions(patient_id)
  WHERE status IN ('ASSINATURA_SOLICITADA','ACTIVE','PAYMENT_PENDING','SUSPENDED','CANCEL_SCHEDULED');

CREATE TABLE subscription_cycles (
  id TEXT PRIMARY KEY,
  subscription_id TEXT NOT NULL REFERENCES subscriptions(id),
  cycle_no INTEGER NOT NULL,
  starts_at TEXT,
  ends_at TEXT,
  status TEXT NOT NULL CHECK (status IN ('PENDING','PAID','FAILED','REFUNDED')),
  created_at TEXT NOT NULL,
  UNIQUE (subscription_id, cycle_no)
);

CREATE TABLE charges (
  id TEXT PRIMARY KEY,
  subscription_id TEXT NOT NULL REFERENCES subscriptions(id),
  cycle_id TEXT NOT NULL REFERENCES subscription_cycles(id),
  amount_cents INTEGER NOT NULL,
  attempt_no INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('PENDING','CONFIRMED','FAILED','REFUNDED')),
  provider TEXT NOT NULL,
  provider_ref TEXT,
  failure_reason TEXT,
  created_at TEXT NOT NULL,
  settled_at TEXT
);

CREATE TABLE service_orders (
  id TEXT PRIMARY KEY,
  patient_id TEXT NOT NULL REFERENCES users(id),
  catalog_item_id TEXT NOT NULL REFERENCES catalog_items(id),
  item_code TEXT NOT NULL,
  item_name TEXT NOT NULL,
  item_kind TEXT NOT NULL,
  full_price_cents INTEGER NOT NULL,
  discount_cents INTEGER NOT NULL DEFAULT 0,
  final_price_cents INTEGER NOT NULL,
  payout_basis_cents INTEGER NOT NULL,     -- repasse calculado sobre o preço cheio
  no_discount_reason TEXT,
  status TEXT NOT NULL CHECK (status IN ('PENDING_PAYMENT','PAID','FAILED','REFUNDED')),
  provider TEXT NOT NULL,
  provider_ref TEXT,
  created_at TEXT NOT NULL,
  paid_at TEXT
);

-- Lock de desconto: no máximo um RESERVED/USED por ciclo (A05 - concorrência)
CREATE TABLE discount_reservations (
  id TEXT PRIMARY KEY,
  subscription_id TEXT NOT NULL REFERENCES subscriptions(id),
  cycle_id TEXT NOT NULL REFERENCES subscription_cycles(id),
  order_id TEXT NOT NULL REFERENCES service_orders(id),
  amount_cents INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('RESERVED','USED','RELEASED')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  release_reason TEXT
);
CREATE UNIQUE INDEX uq_discount_cycle ON discount_reservations(cycle_id) WHERE status IN ('RESERVED','USED');

CREATE TABLE refund_requests (
  id TEXT PRIMARY KEY,
  subscription_id TEXT REFERENCES subscriptions(id),
  charge_id TEXT REFERENCES charges(id),
  order_id TEXT REFERENCES service_orders(id),
  type TEXT NOT NULL CHECK (type IN ('ARREPENDIMENTO','ESTORNO')),
  reason TEXT,
  amount_cents INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('REFUND_PENDING','REFUNDED','REJECTED')),
  protocol TEXT NOT NULL UNIQUE,
  requested_by TEXT NOT NULL,
  requested_at TEXT NOT NULL,
  provider TEXT NOT NULL,
  provider_result TEXT,
  decided_by TEXT,
  decided_at TEXT,
  decision_note TEXT
);

-- Preferências: finalidade x canal (independentes, desativadas por padrão)
CREATE TABLE communication_preferences (
  patient_id TEXT NOT NULL REFERENCES users(id),
  purpose TEXT NOT NULL CHECK (purpose IN ('LEMBRETES','RESUMO_MENSAL','OFERTAS')),
  enabled INTEGER NOT NULL DEFAULT 0,
  channel_app INTEGER NOT NULL DEFAULT 0,
  channel_email INTEGER NOT NULL DEFAULT 0,
  channel_whatsapp INTEGER NOT NULL DEFAULT 0,
  frequency TEXT,
  text_version TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (patient_id, purpose)
);

CREATE TABLE preference_events (
  id TEXT PRIMARY KEY,
  patient_id TEXT NOT NULL,
  event TEXT NOT NULL CHECK (event IN ('OPT_IN','OPT_OUT','CHANGE')),
  purpose TEXT NOT NULL,
  channel TEXT,
  detail_json TEXT,
  source TEXT NOT NULL,
  text_version TEXT,
  occurred_at TEXT NOT NULL
);
CREATE TRIGGER pref_events_no_update BEFORE UPDATE ON preference_events FOR EACH ROW EXECUTE FUNCTION onema_forbid('preference_events is append-only');
CREATE TRIGGER pref_events_no_delete BEFORE DELETE ON preference_events FOR EACH ROW EXECUTE FUNCTION onema_forbid('preference_events is append-only');

-- Responsável principal (rede familiar autorizada)
CREATE TABLE share_grants (
  id TEXT PRIMARY KEY,
  patient_id TEXT NOT NULL REFERENCES users(id),
  invitee_email TEXT NOT NULL CHECK (invitee_email = lower(invitee_email)),
  invitee_name TEXT NOT NULL,
  invitee_user_id TEXT REFERENCES users(id),
  status TEXT NOT NULL CHECK (status IN ('INVITED','ACCEPTED','VERIFIED','REVOKED','EXPIRED','REJECTED')),
  text_version TEXT NOT NULL,
  invited_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  accepted_at TEXT,
  verified_by TEXT,
  verified_at TEXT,
  verification_note TEXT,
  revoked_at TEXT,
  updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX uq_share_principal ON share_grants(patient_id) WHERE status IN ('INVITED','ACCEPTED','VERIFIED');

CREATE TABLE share_scopes (
  grant_id TEXT NOT NULL REFERENCES share_grants(id),
  scope TEXT NOT NULL CHECK (scope IN ('AGENDA','DOCUMENTOS','COBRANCAS')),
  granted_at TEXT,
  revoked_at TEXT,
  PRIMARY KEY (grant_id, scope)
);

CREATE TABLE share_access_log (
  id TEXT PRIMARY KEY,
  grant_id TEXT NOT NULL REFERENCES share_grants(id),
  accessor_id TEXT NOT NULL REFERENCES users(id),
  scope TEXT NOT NULL,
  result TEXT NOT NULL CHECK (result IN ('PERMITIDO','NEGADO')),
  accessed_at TEXT NOT NULL
);
CREATE TRIGGER share_log_no_update BEFORE UPDATE ON share_access_log FOR EACH ROW EXECUTE FUNCTION onema_forbid('share_access_log is append-only');
CREATE TRIGGER share_log_no_delete BEFORE DELETE ON share_access_log FOR EACH ROW EXECUTE FUNCTION onema_forbid('share_access_log is append-only');

-- Comprovantes/confirmações exibidos ao usuário (T3), com protocolo
CREATE TABLE prime_receipts (
  id TEXT PRIMARY KEY,
  patient_id TEXT NOT NULL REFERENCES users(id),
  kind TEXT NOT NULL,
  protocol TEXT,
  text TEXT NOT NULL,
  created_at TEXT NOT NULL
);
` },
  { name: '004_settings', sql: `
-- Segredos gerados na primeira inicialização quando não fornecidos por variável de ambiente
-- (assinatura de URLs de mídia e webhooks). Acesso restrito ao servidor; nunca expostos pela API.
CREATE TABLE system_settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  created_at TEXT NOT NULL
);
` },
  { name: '005_media_chunks_user_deletion', sql: `
-- Envio de mídia em partes (limite de ~6 MB por requisição de Function) e exclusão de usuários.
ALTER TABLE academy_media_assets DROP CONSTRAINT IF EXISTS academy_media_assets_state_check;
ALTER TABLE academy_media_assets ADD CONSTRAINT academy_media_assets_state_check CHECK (state IN ('UPLOADING','PENDING','APPROVED','BLOCKED'));
ALTER TABLE academy_media_assets ALTER COLUMN size_bytes TYPE BIGINT;
ALTER TABLE academy_media_assets ADD COLUMN chunk_size INTEGER;
ALTER TABLE academy_media_assets ADD COLUMN chunk_count INTEGER;
CREATE TABLE academy_media_chunks (
  asset_id TEXT NOT NULL REFERENCES academy_media_assets(id) ON DELETE CASCADE,
  n INTEGER NOT NULL,
  size_bytes INTEGER NOT NULL,
  sha256 TEXT NOT NULL,
  PRIMARY KEY (asset_id, n)
);
ALTER TABLE users ADD COLUMN deleted_at TEXT;
` },
];

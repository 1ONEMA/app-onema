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
CREATE TRIGGER cert_immutable BEFORE UPDATE OF snapshot_json, content_hash, public_code, issued_at, enrollment_id ON academy_certificates
BEGIN SELECT RAISE(ABORT, 'certificate evidence is immutable'); END;
CREATE TRIGGER cert_no_delete BEFORE DELETE ON academy_certificates
BEGIN SELECT RAISE(ABORT, 'certificate evidence is immutable'); END;

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

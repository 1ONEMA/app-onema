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
CREATE TRIGGER pref_events_no_update BEFORE UPDATE ON preference_events
BEGIN SELECT RAISE(ABORT, 'preference_events is append-only'); END;
CREATE TRIGGER pref_events_no_delete BEFORE DELETE ON preference_events
BEGIN SELECT RAISE(ABORT, 'preference_events is append-only'); END;

-- Responsável principal (rede familiar autorizada)
CREATE TABLE share_grants (
  id TEXT PRIMARY KEY,
  patient_id TEXT NOT NULL REFERENCES users(id),
  invitee_email TEXT NOT NULL COLLATE NOCASE,
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
CREATE TRIGGER share_log_no_update BEFORE UPDATE ON share_access_log
BEGIN SELECT RAISE(ABORT, 'share_access_log is append-only'); END;
CREATE TRIGGER share_log_no_delete BEFORE DELETE ON share_access_log
BEGIN SELECT RAISE(ABORT, 'share_access_log is append-only'); END;

-- Comprovantes/confirmações exibidos ao usuário (T3), com protocolo
CREATE TABLE prime_receipts (
  id TEXT PRIMARY KEY,
  patient_id TEXT NOT NULL REFERENCES users(id),
  kind TEXT NOT NULL,
  protocol TEXT,
  text TEXT NOT NULL,
  created_at TEXT NOT NULL
);

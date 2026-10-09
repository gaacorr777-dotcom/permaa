import { neon } from '@neondatabase/serverless';

if (!process.env.DATABASE_URL) {
  throw new Error('Environment variable DATABASE_URL belum diatur.');
}

export const sql = neon(process.env.DATABASE_URL);

let schemaReady;

export function ensureSchema() {
  if (!schemaReady) {
    schemaReady = (async () => {
      await sql`
        CREATE TABLE IF NOT EXISTS users (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          email TEXT NOT NULL UNIQUE,
          google_sub TEXT,
          balance BIGINT NOT NULL DEFAULT 0 CHECK (balance >= 0),
          password_salt TEXT NOT NULL,
          password_hash TEXT NOT NULL,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `;
      await sql`ALTER TABLE users ADD COLUMN IF NOT EXISTS google_sub TEXT`;
      await sql`CREATE UNIQUE INDEX IF NOT EXISTS users_google_sub_idx ON users(google_sub) WHERE google_sub IS NOT NULL`;
      await sql`
        CREATE TABLE IF NOT EXISTS sessions (
          token_hash TEXT PRIMARY KEY,
          user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          expires_at TIMESTAMPTZ NOT NULL,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `;
      await sql`CREATE INDEX IF NOT EXISTS sessions_user_id_idx ON sessions(user_id)`;
      await sql`
        CREATE TABLE IF NOT EXISTS topups (
          id TEXT PRIMARY KEY,
          user_id TEXT NOT NULL REFERENCES users(id),
          amount BIGINT NOT NULL CHECK (amount > 0),
          status TEXT NOT NULL CHECK (status IN ('pending', 'approved', 'rejected')),
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          reviewed_at TIMESTAMPTZ
        )
      `;
      await sql`
        DO $$
        BEGIN
          IF EXISTS (
            SELECT 1 FROM pg_constraint
            WHERE conrelid = 'topups'::regclass
              AND conname = 'topups_status_check'
              AND pg_get_constraintdef(oid) NOT LIKE '%pending_payment%'
          ) THEN
            ALTER TABLE topups DROP CONSTRAINT topups_status_check;
          END IF;
          IF NOT EXISTS (
            SELECT 1 FROM pg_constraint
            WHERE conrelid = 'topups'::regclass AND conname = 'topups_status_check'
          ) THEN
            ALTER TABLE topups ADD CONSTRAINT topups_status_check
            CHECK (status IN ('pending', 'approved', 'rejected', 'pending_payment', 'paid', 'expired'));
          END IF;
        END $$
      `;
      await sql`ALTER TABLE topups ADD COLUMN IF NOT EXISTS payment_method TEXT`;
      await sql`ALTER TABLE topups ADD COLUMN IF NOT EXISTS gateway_invoice_id TEXT`;
      await sql`ALTER TABLE topups ADD COLUMN IF NOT EXISTS payment_total BIGINT`;
      await sql`ALTER TABLE topups ADD COLUMN IF NOT EXISTS qris_image TEXT`;
      await sql`ALTER TABLE topups ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ`;
      await sql`CREATE UNIQUE INDEX IF NOT EXISTS topups_gateway_invoice_idx ON topups(gateway_invoice_id) WHERE gateway_invoice_id IS NOT NULL`;
      await sql`CREATE INDEX IF NOT EXISTS topups_user_created_idx ON topups(user_id, created_at DESC)`;
      await sql`
        CREATE TABLE IF NOT EXISTS orders (
          id TEXT PRIMARY KEY,
          user_id TEXT NOT NULL REFERENCES users(id),
          product_id TEXT NOT NULL,
          product_name TEXT NOT NULL,
          product_type TEXT NOT NULL CHECK (product_type IN ('number', 'smm')),
          amount BIGINT NOT NULL CHECK (amount >= 0),
          target TEXT,
          quantity INTEGER,
          comments TEXT,
          username TEXT,
          customer_name TEXT NOT NULL,
          customer_phone TEXT NOT NULL,
          client_request_id TEXT,
          status TEXT NOT NULL,
          provider_order_id TEXT,
          provider_status TEXT,
          provider_start_count TEXT,
          provider_remains TEXT,
          provider_error TEXT,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          provider_submitted_at TIMESTAMPTZ,
          completed_at TIMESTAMPTZ,
          reviewed_at TIMESTAMPTZ,
          provider_catalog_product_id INTEGER,
          provider_max_price BIGINT,
          provider_operator_id INTEGER,
          UNIQUE (user_id, client_request_id)
        )
      `;
      await sql`ALTER TABLE orders ADD COLUMN IF NOT EXISTS provider_catalog_product_id INTEGER`;
      await sql`ALTER TABLE orders ADD COLUMN IF NOT EXISTS provider_max_price BIGINT`;
      await sql`ALTER TABLE orders ADD COLUMN IF NOT EXISTS provider_operator_id INTEGER`;
      await sql`CREATE INDEX IF NOT EXISTS orders_user_created_idx ON orders(user_id, created_at DESC)`;
      await sql`CREATE INDEX IF NOT EXISTS orders_status_idx ON orders(status)`;
      await sql`
        CREATE TABLE IF NOT EXISTS ledger (
          id TEXT PRIMARY KEY,
          user_id TEXT NOT NULL REFERENCES users(id),
          type TEXT NOT NULL CHECK (type IN ('purchase', 'topup', 'refund')),
          amount BIGINT NOT NULL,
          order_id TEXT REFERENCES orders(id),
          topup_id TEXT REFERENCES topups(id),
          balance_after BIGINT NOT NULL CHECK (balance_after >= 0),
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `;
      await sql`CREATE INDEX IF NOT EXISTS ledger_user_created_idx ON ledger(user_id, created_at DESC)`;
      await sql`
        CREATE TABLE IF NOT EXISTS auth_attempts (
          ip_hash TEXT PRIMARY KEY,
          attempts TIMESTAMPTZ[] NOT NULL DEFAULT '{}'
        )
      `;
    })().catch((error) => {
      schemaReady = undefined;
      throw error;
    });
  }
  return schemaReady;
}

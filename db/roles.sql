-- Least-privilege role the application connects as. Run as the database owner:
--   psql <owner connection> -v app_password=... -f db/roles.sql
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ledger_app') THEN
    CREATE ROLE ledger_app LOGIN;
  END IF;
END
$$;

ALTER ROLE ledger_app PASSWORD :'app_password';

REVOKE ALL ON ALL TABLES IN SCHEMA public FROM ledger_app;
GRANT USAGE ON SCHEMA public TO ledger_app;

-- Append-only data: add rows, read rows, nothing else.
GRANT SELECT, INSERT ON users, transactions, ledger_entries, refused_attempts TO ledger_app;

-- Accounts: the application may change the balance and nothing else on existing rows.
GRANT SELECT, INSERT ON accounts TO ledger_app;
GRANT UPDATE (balance) ON accounts TO ledger_app;

-- Idempotency keys: add, read, count replays.
GRANT SELECT, INSERT ON idempotency_keys TO ledger_app;
GRANT UPDATE (replay_count) ON idempotency_keys TO ledger_app;

-- DISPOSABLE DEMO ONLY. Do not run this against an existing or production database.
-- The public demo password must never be reused for real data.
REVOKE ALL ON DATABASE agentkey_demo FROM PUBLIC;
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
CREATE ROLE agentkey_reader LOGIN PASSWORD 'agentkey-demo-reader-only'
  NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
ALTER ROLE agentkey_reader SET default_transaction_read_only = on;
GRANT CONNECT ON DATABASE agentkey_demo TO agentkey_reader;
GRANT USAGE ON SCHEMA public TO agentkey_reader;
CREATE TABLE public.products (
  id integer PRIMARY KEY,
  name text NOT NULL,
  internal_token text NOT NULL
);
INSERT INTO public.products VALUES
  (1, 'Notebook', 'synthetic-private-data'),
  (2, 'Pencil', 'synthetic-private-data');
GRANT SELECT (id, name) ON public.products TO agentkey_reader;

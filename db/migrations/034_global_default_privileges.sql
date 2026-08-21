-- Supabase projects can carry role-wide defaults that grant newly created
-- objects to API roles. Schema-scoped defaults are additive, so revoke the
-- role-wide grants too; migration 033 already grants service_role in public.

ALTER DEFAULT PRIVILEGES FOR ROLE postgres
  REVOKE ALL PRIVILEGES ON TABLES FROM PUBLIC, anon, authenticated;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres
  REVOKE ALL PRIVILEGES ON SEQUENCES FROM PUBLIC, anon, authenticated;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres
  REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC, anon, authenticated;

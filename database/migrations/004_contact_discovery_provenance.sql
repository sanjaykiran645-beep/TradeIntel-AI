-- Contact discovery adds provenance without rewriting historical contact rows.
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS phone text;
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS discovery_provider text;
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS discovered_at timestamptz;

-- Provider retries must not create the same discovered address twice for one company.
CREATE UNIQUE INDEX IF NOT EXISTS contacts_discovered_email_uq
  ON contacts (dataset_id, company_id, lower(email))
  WHERE discovery_provider IS NOT NULL AND email IS NOT NULL AND company_id IS NOT NULL;

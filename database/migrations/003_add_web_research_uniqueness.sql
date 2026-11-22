-- The unique index also supports ON CONFLICT (dataset_id, company_id).
-- IF NOT EXISTS keeps recovery safe if the schema change predates its history row.
CREATE UNIQUE INDEX IF NOT EXISTS web_research_dataset_company_key
  ON public.web_research (dataset_id, company_id);

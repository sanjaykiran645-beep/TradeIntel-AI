ALTER TABLE public.company_potential
  ALTER COLUMN growth_score DROP NOT NULL,
  ALTER COLUMN growth_score DROP DEFAULT,
  ALTER COLUMN engagement_score DROP NOT NULL,
  ALTER COLUMN engagement_score DROP DEFAULT;

-- Older deployments used research_result. The current schema stores provider
-- payloads in result, so this compatibility rename is a no-op there.
DO $migration$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name = 'web_research'
       AND column_name = 'research_result'
  ) AND NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name = 'web_research'
       AND column_name = 'research_data'
  ) THEN
    ALTER TABLE public.web_research RENAME COLUMN research_result TO research_data;
  END IF;
END
$migration$;

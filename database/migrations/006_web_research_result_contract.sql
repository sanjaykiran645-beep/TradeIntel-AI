-- Align legacy payload column names with the API's current `result` contract.
-- Rename only when one unambiguous legacy column exists; never discard payloads.
DO $migration$
DECLARE
  has_result boolean;
  has_research_result boolean;
  has_research_data boolean;
BEGIN
  SELECT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'web_research' AND column_name = 'result'
  ) INTO has_result;
  IF has_result THEN
    RETURN;
  END IF;

  SELECT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'web_research' AND column_name = 'research_result'
  ) INTO has_research_result;
  SELECT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'web_research' AND column_name = 'research_data'
  ) INTO has_research_data;

  IF has_research_result AND has_research_data THEN
    RAISE EXCEPTION 'web_research has two legacy payload columns; resolve the ambiguity before migration';
  ELSIF has_research_result THEN
    ALTER TABLE public.web_research RENAME COLUMN research_result TO result;
  ELSIF has_research_data THEN
    ALTER TABLE public.web_research RENAME COLUMN research_data TO result;
  ELSE
    RAISE EXCEPTION 'web_research has no recognized payload column; inspect the existing schema before migration';
  END IF;
END
$migration$;

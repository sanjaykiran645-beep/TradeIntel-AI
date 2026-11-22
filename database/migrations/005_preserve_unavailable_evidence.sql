-- Keep unknown measurements and unavailable scoring factors as NULL. This only
-- changes defaults/nullability; it does not rewrite existing records.
ALTER TABLE public.normalized_records
  ALTER COLUMN quantity DROP NOT NULL,
  ALTER COLUMN quantity DROP DEFAULT,
  ALTER COLUMN value_amount DROP NOT NULL,
  ALTER COLUMN value_amount DROP DEFAULT,
  ALTER COLUMN unit DROP NOT NULL,
  ALTER COLUMN unit DROP DEFAULT,
  ALTER COLUMN currency DROP NOT NULL,
  ALTER COLUMN currency DROP DEFAULT;

ALTER TABLE public.companies
  ALTER COLUMN total_value DROP NOT NULL,
  ALTER COLUMN total_value DROP DEFAULT;

ALTER TABLE public.products
  ALTER COLUMN total_demand_qty DROP NOT NULL,
  ALTER COLUMN total_demand_qty DROP DEFAULT,
  ALTER COLUMN total_demand_val DROP NOT NULL,
  ALTER COLUMN total_demand_val DROP DEFAULT;

ALTER TABLE public.markets
  ALTER COLUMN total_trade_volume DROP NOT NULL,
  ALTER COLUMN total_trade_volume DROP DEFAULT;

ALTER TABLE public.company_potential
  ALTER COLUMN product_fit_score DROP NOT NULL,
  ALTER COLUMN product_fit_score DROP DEFAULT,
  ALTER COLUMN activity_score DROP NOT NULL,
  ALTER COLUMN activity_score DROP DEFAULT,
  ALTER COLUMN recency_score DROP NOT NULL,
  ALTER COLUMN recency_score DROP DEFAULT,
  ALTER COLUMN market_fit_score DROP NOT NULL,
  ALTER COLUMN market_fit_score DROP DEFAULT,
  ALTER COLUMN commercial_relevance_score DROP NOT NULL,
  ALTER COLUMN commercial_relevance_score DROP DEFAULT,
  ALTER COLUMN supplier_diversification_score DROP NOT NULL,
  ALTER COLUMN supplier_diversification_score DROP DEFAULT;

-- Both research API paths persist updated_at when replacing a provider result.
ALTER TABLE public.web_research
  ADD COLUMN IF NOT EXISTS updated_at timestamptz;

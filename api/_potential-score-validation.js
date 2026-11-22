export const POTENTIAL_SCORE_VALIDATION_SQL = `
  SELECT count(*)::bigint AS score_count,
         count(*) FILTER (WHERE
           cp.product_fit_score < 0 OR cp.product_fit_score > 20 OR
           cp.activity_score < 0 OR cp.activity_score > 15 OR
           cp.recency_score < 0 OR cp.recency_score > 15 OR
           cp.market_fit_score < 0 OR cp.market_fit_score > 10 OR
           cp.commercial_relevance_score < 0 OR cp.commercial_relevance_score > 15 OR
           cp.growth_score < 0 OR cp.growth_score > 10 OR
           cp.supplier_diversification_score < 0 OR cp.supplier_diversification_score > 5 OR
           cp.engagement_score < 0 OR cp.engagement_score > 10 OR
           cp.total_score::text IN ('NaN', 'Infinity', '-Infinity') OR
           COALESCE(cp.evidence_breakdown #>> '{factors,productFit,status}', '') NOT IN ('AVAILABLE','UNAVAILABLE') OR
           COALESCE(cp.evidence_breakdown #>> '{factors,activity,status}', '') NOT IN ('AVAILABLE','UNAVAILABLE') OR
           COALESCE(cp.evidence_breakdown #>> '{factors,recency,status}', '') NOT IN ('AVAILABLE','UNAVAILABLE') OR
           COALESCE(cp.evidence_breakdown #>> '{factors,marketFit,status}', '') NOT IN ('AVAILABLE','UNAVAILABLE') OR
           COALESCE(cp.evidence_breakdown #>> '{factors,commercialRelevance,status}', '') NOT IN ('AVAILABLE','UNAVAILABLE') OR
           COALESCE(cp.evidence_breakdown #>> '{factors,growth,status}', '') NOT IN ('AVAILABLE','UNAVAILABLE') OR
           COALESCE(cp.evidence_breakdown #>> '{factors,supplierDiversification,status}', '') NOT IN ('AVAILABLE','UNAVAILABLE') OR
           COALESCE(cp.evidence_breakdown #>> '{factors,engagement,status}', '') NOT IN ('AVAILABLE','UNAVAILABLE') OR
           (cp.evidence_breakdown #>> '{factors,productFit,status}' = 'AVAILABLE' AND cp.product_fit_score IS NULL) OR
           (cp.evidence_breakdown #>> '{factors,productFit,status}' = 'UNAVAILABLE' AND cp.product_fit_score IS NOT NULL) OR
           (cp.evidence_breakdown #>> '{factors,activity,status}' = 'AVAILABLE' AND cp.activity_score IS NULL) OR
           (cp.evidence_breakdown #>> '{factors,activity,status}' = 'UNAVAILABLE' AND cp.activity_score IS NOT NULL) OR
           (cp.evidence_breakdown #>> '{factors,recency,status}' = 'AVAILABLE' AND cp.recency_score IS NULL) OR
           (cp.evidence_breakdown #>> '{factors,recency,status}' = 'UNAVAILABLE' AND cp.recency_score IS NOT NULL) OR
           (cp.evidence_breakdown #>> '{factors,marketFit,status}' = 'AVAILABLE' AND cp.market_fit_score IS NULL) OR
           (cp.evidence_breakdown #>> '{factors,marketFit,status}' = 'UNAVAILABLE' AND cp.market_fit_score IS NOT NULL) OR
           (cp.evidence_breakdown #>> '{factors,commercialRelevance,status}' = 'AVAILABLE' AND cp.commercial_relevance_score IS NULL) OR
           (cp.evidence_breakdown #>> '{factors,commercialRelevance,status}' = 'UNAVAILABLE' AND cp.commercial_relevance_score IS NOT NULL) OR
           (cp.evidence_breakdown #>> '{factors,growth,status}' = 'AVAILABLE' AND cp.growth_score IS NULL) OR
           (cp.evidence_breakdown #>> '{factors,growth,status}' = 'UNAVAILABLE' AND cp.growth_score IS NOT NULL) OR
           (cp.evidence_breakdown #>> '{factors,supplierDiversification,status}' = 'AVAILABLE' AND cp.supplier_diversification_score IS NULL) OR
           (cp.evidence_breakdown #>> '{factors,supplierDiversification,status}' = 'UNAVAILABLE' AND cp.supplier_diversification_score IS NOT NULL) OR
           (cp.evidence_breakdown #>> '{factors,engagement,status}' = 'AVAILABLE' AND cp.engagement_score IS NULL) OR
           (cp.evidence_breakdown #>> '{factors,engagement,status}' = 'UNAVAILABLE' AND cp.engagement_score IS NOT NULL) OR
           NULLIF(cp.evidence_breakdown #>> '{scoreMetadata,availableWeight}', '') IS NULL OR
           NULLIF(cp.evidence_breakdown #>> '{scoreMetadata,rawWeightedScore}', '') IS NULL OR
           cp.total_score IS DISTINCT FROM NULLIF(cp.evidence_breakdown #>> '{scoreMetadata,normalizedScore}', '')::numeric OR
           ROUND(
             COALESCE(cp.product_fit_score, 0) + COALESCE(cp.activity_score, 0) +
             COALESCE(cp.recency_score, 0) + COALESCE(cp.market_fit_score, 0) +
             COALESCE(cp.commercial_relevance_score, 0) + COALESCE(cp.growth_score, 0) +
             COALESCE(cp.supplier_diversification_score, 0) + COALESCE(cp.engagement_score, 0), 2
           ) IS DISTINCT FROM NULLIF(cp.evidence_breakdown #>> '{scoreMetadata,rawWeightedScore}', '')::numeric OR
           NULLIF(cp.evidence_breakdown #>> '{scoreMetadata,availableWeight}', '')::numeric IS DISTINCT FROM
             (CASE WHEN cp.evidence_breakdown #>> '{factors,productFit,status}' = 'AVAILABLE' THEN 20 ELSE 0 END +
              CASE WHEN cp.evidence_breakdown #>> '{factors,activity,status}' = 'AVAILABLE' THEN 15 ELSE 0 END +
              CASE WHEN cp.evidence_breakdown #>> '{factors,recency,status}' = 'AVAILABLE' THEN 15 ELSE 0 END +
              CASE WHEN cp.evidence_breakdown #>> '{factors,marketFit,status}' = 'AVAILABLE' THEN 10 ELSE 0 END +
              CASE WHEN cp.evidence_breakdown #>> '{factors,commercialRelevance,status}' = 'AVAILABLE' THEN 15 ELSE 0 END +
              CASE WHEN cp.evidence_breakdown #>> '{factors,growth,status}' = 'AVAILABLE' THEN 10 ELSE 0 END +
              CASE WHEN cp.evidence_breakdown #>> '{factors,supplierDiversification,status}' = 'AVAILABLE' THEN 5 ELSE 0 END +
              CASE WHEN cp.evidence_breakdown #>> '{factors,engagement,status}' = 'AVAILABLE' THEN 10 ELSE 0 END)::numeric OR
           cp.total_score IS DISTINCT FROM ROUND(
             NULLIF(cp.evidence_breakdown #>> '{scoreMetadata,rawWeightedScore}', '')::numeric /
             NULLIF(cp.evidence_breakdown #>> '{scoreMetadata,availableWeight}', '')::numeric * 100, 2
           )
         )::bigint AS invalid_score_count,
         min(cp.total_score)::text AS min_score,
         max(cp.total_score)::text AS max_score,
         count(*) FILTER (WHERE cp.growth_score = 0)::bigint AS growth_zero_count,
         count(*) FILTER (WHERE cp.supplier_diversification_score = 0)::bigint AS supplier_diversification_zero_count
    FROM company_potential cp
    JOIN companies c ON c.dataset_id = cp.dataset_id AND c.id = cp.company_id
   WHERE cp.dataset_id = $1 AND cp.company_id = ANY($2::bigint[])
`;

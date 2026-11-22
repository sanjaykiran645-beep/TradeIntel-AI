import supabase from '../_db-client.js';
import { apiErrorResponse, normalizeDatabaseError, setCors, getHostingerConfig, requireAuth } from '../_utils.js';
import { resolveDatasetId } from '../_dataset-scope.js';

function databaseFailure(error, operation) {
  return normalizeDatabaseError(error, `${operation} could not read the database.`);
}

async function readDashboardSummary(datasetId) {
  const { rows } = await supabase.query(
    `WITH outreach_summary AS (
       SELECT COUNT(*) AS emails_generated,
              COUNT(*) FILTER (WHERE status IN ('SENT', 'MANUALLY_CONFIRMED_SENT', 'REPLIED')) AS emails_sent
         FROM outreach_emails
        WHERE dataset_id = $1
     ),
     lead_summary AS (
       SELECT COUNT(*) FILTER (
                WHERE l.intent_type <> 'COMPANY_POTENTIAL'
                   OR (cp.total_score >= 75 AND c.total_transactions >= 10)
              ) AS qualified_leads,
              COUNT(*) FILTER (
                WHERE l.intent_type = 'COMPANY_POTENTIAL'
                  AND NOT COALESCE(cp.total_score >= 75 AND c.total_transactions >= 10, false)
              ) AS historical_legacy_leads,
              COUNT(*) FILTER (
                WHERE l.intent_type = 'COMPANY_POTENTIAL'
                  AND cp.total_score >= 75
                  AND c.total_transactions >= 10
                  AND NULLIF(l.evidence #>> '{pitchingEmailPreview,subject}', '') IS NOT NULL
                  AND NULLIF(l.evidence #>> '{pitchingEmailPreview,bodyText}', '') IS NOT NULL
              ) AS email_previews
         FROM leads l
         LEFT JOIN companies c ON c.dataset_id = l.dataset_id AND c.id = l.company_id
         LEFT JOIN company_potential cp ON cp.dataset_id = l.dataset_id AND cp.company_id = l.company_id
        WHERE l.dataset_id = $1
     ),
     metrics AS (
       SELECT
         (SELECT COUNT(*) FROM datasets) AS datasets,
         (SELECT COUNT(*) FROM raw_records WHERE dataset_id = $1) AS raw_records,
         (SELECT COUNT(*) FROM companies WHERE dataset_id = $1) AS companies,
         (SELECT COUNT(*) FROM products WHERE dataset_id = $1) AS products,
         (SELECT COUNT(*) FROM markets WHERE dataset_id = $1) AS markets,
         (SELECT COUNT(*) FROM web_research WHERE dataset_id = $1) AS research,
         (SELECT COUNT(*) FROM contacts WHERE dataset_id = $1) AS contacts,
         outreach_summary.emails_generated,
         outreach_summary.emails_sent,
         (SELECT COUNT(*) FROM inbox_messages WHERE dataset_id = $1) AS inbox_messages,
         (SELECT COUNT(*) FROM follow_up_queue WHERE dataset_id = $1) AS follow_ups_pending,
         lead_summary.qualified_leads,
         lead_summary.historical_legacy_leads,
         lead_summary.email_previews
       FROM outreach_summary
       CROSS JOIN lead_summary
     ),
     trade_groups AS (
       SELECT currency,
              unit,
              SUM(value_amount) AS total_value,
              SUM(quantity) AS total_quantity,
              COUNT(*) AS record_count,
              GROUPING(currency) AS currency_omitted,
              GROUPING(unit) AS unit_omitted
         FROM normalized_records
        WHERE dataset_id = $1
        GROUP BY GROUPING SETS ((currency), (unit), ())
     ),
     potential_groups AS (
       SELECT category,
              GROUPING(category) AS is_total,
              COUNT(*) AS category_count,
              COUNT(*) AS score_count,
              AVG(total_score) AS average_score,
              MIN(total_score) AS minimum_score,
              MAX(total_score) AS maximum_score,
              AVG((evidence_breakdown #>> '{scoreMetadata,evidenceCoveragePercent}')::numeric) AS average_evidence_coverage,
              AVG(supplier_diversification_score) AS average_supplier_diversification,
              COUNT(*) FILTER (WHERE growth_score IS NULL) AS growth_unavailable_count,
              COUNT(*) FILTER (WHERE engagement_score IS NULL) AS engagement_unavailable_count
         FROM company_potential
        WHERE dataset_id = $1
        GROUP BY GROUPING SETS ((category), ())
     )
     SELECT
       (SELECT to_jsonb(metrics) FROM metrics) AS metrics,
       (SELECT record_count FROM trade_groups WHERE currency_omitted = 1 AND unit_omitted = 1) AS normalized_records,
       COALESCE(
         (SELECT jsonb_agg(jsonb_build_object('currency', currency, 'totalValue', total_value) ORDER BY currency)
            FROM trade_groups WHERE currency_omitted = 0),
         '[]'::jsonb
       ) AS trade_value_by_currency,
       COALESCE(
         (SELECT jsonb_agg(jsonb_build_object('unit', unit, 'totalQuantity', total_quantity) ORDER BY unit)
            FROM trade_groups WHERE unit_omitted = 0),
         '[]'::jsonb
       ) AS trade_quantity_by_unit,
       COALESCE(
         (SELECT jsonb_agg(jsonb_build_object('country', country, 'totalTradeVolume', total_trade_volume, 'companies', active_companies_count) ORDER BY total_trade_volume DESC)
            FROM (SELECT country, total_trade_volume, active_companies_count
                    FROM markets WHERE dataset_id = $1
                   ORDER BY total_trade_volume DESC LIMIT 5) top_markets),
         '[]'::jsonb
       ) AS top_markets,
       COALESCE(
         (SELECT jsonb_agg(jsonb_build_object('product', name, 'category', category, 'totalDemandValue', total_demand_val, 'frequency', frequency) ORDER BY total_demand_val DESC)
            FROM (SELECT name, category, total_demand_val, frequency
                    FROM products WHERE dataset_id = $1
                   ORDER BY total_demand_val DESC LIMIT 5) top_products),
         '[]'::jsonb
       ) AS top_products,
       (SELECT jsonb_build_object(
          'score_count', score_count,
          'average_score', average_score,
          'minimum_score', minimum_score,
          'maximum_score', maximum_score,
          'average_evidence_coverage', average_evidence_coverage,
          'average_supplier_diversification', average_supplier_diversification,
          'growth_unavailable_count', growth_unavailable_count,
          'engagement_unavailable_count', engagement_unavailable_count
        ) FROM potential_groups WHERE is_total = 1) AS score_summary,
         COALESCE(
           (SELECT jsonb_agg(jsonb_build_object('category', category, 'count', category_count) ORDER BY category)
              FROM potential_groups WHERE is_total = 0),
           '[]'::jsonb
         ) AS potential_categories`,
    [datasetId]
  );
  return rows[0] || {};
}

export default async function handler(req, res) {
  const startedAt = Date.now();
  setCors(res);
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (!(await requireAuth(req, res))) return;

  try {
    if (req.method === 'GET') {
      const datasetId = await resolveDatasetId(req);
      const intelligenceSummary = await readDashboardSummary(datasetId);
      const metrics = intelligenceSummary.metrics || {};
      const rawRecordCount = Number(metrics.raw_records) || 0;
      const normalizedRecordCount = Number(intelligenceSummary.normalized_records) || 0;
      const { data: datasetStatus, error: datasetStatusError } = await supabase
        .from('datasets')
        .select('detected_entities')
        .eq('id', datasetId)
        .maybeSingle();
      if (datasetStatusError) throw databaseFailure(datasetStatusError, 'Reading pipeline stage status');
      const pipelineStages = datasetStatus?.detected_entities?.pipeline?.stages || {};
      const riskStage = pipelineStages.SQL_RISK_ANALYSIS || {};
      const smtpStage = pipelineStages.SMTP || {};

      const [recentLeadsResult, recentActivitiesResult, hostinger] = await Promise.all([
        supabase
          .from('leads')
          .select('*, companies(name, country)')
          .eq('dataset_id', datasetId)
          .order('created_at', { ascending: false })
          .limit(5),
        supabase
          .from('crm_activities')
          .select('*')
          .eq('dataset_id', datasetId)
          .order('created_at', { ascending: false })
          .limit(8),
        getHostingerConfig()
      ]);
      if (recentLeadsResult.error) throw databaseFailure(recentLeadsResult.error, 'Reading recent leads');
      if (recentActivitiesResult.error) throw databaseFailure(recentActivitiesResult.error, 'Reading recent activities');
      const recentLeads = recentLeadsResult.data;
      const recentActivities = recentActivitiesResult.data;

      const potentialDist = {
        VERY_HIGH: 0,
        HIGH: 0,
        MEDIUM: 0,
        LOW: 0,
        INSUFFICIENT_DATA: 0
      };
      (intelligenceSummary.potential_categories || []).forEach(row => {
        if (potentialDist[row.category] !== undefined) potentialDist[row.category] = Number(row.count);
      });

      const hasData = Number(metrics.companies) > 0 || Number(metrics.products) > 0 || Number(metrics.markets) > 0 || Number(metrics.qualified_leads) > 0;

      console.info(`[API] GET /api/dashboard status=200 duration=${Date.now() - startedAt}ms`);
      return res.status(200).json({
        success: true,
        datasetId,
        hasData,
        metrics: {
          datasets: Number(metrics.datasets) || 0,
          rawRecords: rawRecordCount,
          normalizedRecords: normalizedRecordCount,
          duplicateSourceRows: Math.max(0, rawRecordCount - normalizedRecordCount),
          companies: Number(metrics.companies) || 0,
          products: Number(metrics.products) || 0,
          markets: Number(metrics.markets) || 0,
          research: Number(metrics.research) || 0,
          contacts: Number(metrics.contacts) || 0,
          emailsGenerated: Number(metrics.emails_generated) || 0,
          emailPreviews: Number(metrics.email_previews) || 0,
          emailsSent: Number(metrics.emails_sent) || 0,
          inboxMessages: Number(metrics.inbox_messages) || 0,
          followUpsPending: Number(metrics.follow_ups_pending) || 0,
          qualifiedLeads: Number(metrics.qualified_leads) || 0,
          historicalLegacyLeads: Number(metrics.historical_legacy_leads) || 0
        },
        potentialDistribution: potentialDist,
        intelligence: {
          ...(intelligenceSummary.score_summary || {}),
          tradeValueByCurrency: intelligenceSummary.trade_value_by_currency || [],
          tradeQuantityByUnit: intelligenceSummary.trade_quantity_by_unit || [],
          topMarkets: intelligenceSummary.top_markets || [],
          topProducts: intelligenceSummary.top_products || [],
          contactAvailability: {
            totalContacts: Number(metrics.contacts) || 0,
            status: Number(metrics.contacts) > 0 ? 'AVAILABLE' : 'UNAVAILABLE',
            verifiedContacts: Number(pipelineStages.SQL_RISK_ANALYSIS?.evidence?.verifiedUnsuppressedContactCount || 0)
          },
          riskStatus: pipelineStages.SQL_RISK_ANALYSIS?.status || 'NOT_RUN',
          riskSummary: {
            status: riskStage.status || 'NOT_RUN',
            outreachSafetyLevel: riskStage.evidence?.riskLevel || null,
            concentrationMetrics: riskStage.evidence?.concentrationMetrics || null
          },
          researchStatus: pipelineStages.RESEARCH?.status || 'NOT_RUN',
          researchAvailability: Number(metrics.research) > 0 ? 'AVAILABLE' : 'UNAVAILABLE',
          contactDiscoveryStatus: pipelineStages.CONTACT_DISCOVERY?.status || 'NOT_RUN',
          emailDraftStatus: pipelineStages.EMAIL_DRAFT?.status || 'NOT_RUN',
          emailDraftCount: Number(metrics.emails_generated) || 0,
          emailPreviewCount: Number(metrics.email_previews) || 0,
          emailSendingEnabled: process.env.EMAIL_SENDING_ENABLED === 'true' && hostinger.configured,
          emailSendingStatus: Number(metrics.emails_sent) > 0 ? 'SENT' : smtpStage.status === 'BLOCKED' ? 'OFF' : 'NOT_SENT',
          emailsSent: Number(metrics.emails_sent) || 0
        },
        hostingerIntegration: {
          configured: hostinger.configured,
          status: hostinger.configurationError?.code || (hostinger.configured ? 'CONFIGURED' : 'NOT CONFIGURED'),
          configurationError: hostinger.configurationError,
          host: hostinger.configured ? hostinger.smtp.host : null
        },
        recentLeads: recentLeads || [],
        recentActivities: recentActivities || []
      });
    }

    res.status(405).json({ error: 'Method not allowed' });
  } catch (err) {
    const normalized = normalizeDatabaseError(err, 'Dashboard query failed.');
    console.error(`[API] ${req.method} /api/dashboard status=${normalized.status} code=${normalized.code}`);
    return apiErrorResponse(res, normalized, 'DASHBOARD_ERROR');
  }
}

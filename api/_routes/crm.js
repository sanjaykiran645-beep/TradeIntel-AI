import supabase from '../_db-client.js';
import { apiErrorResponse, setCors, requireAuth } from '../_utils.js';
import { resolveDatasetId } from '../_dataset-scope.js';

export default async function handler(req, res) {
  setCors(res);
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (!(await requireAuth(req, res))) return;

  try {
    if (req.method === 'GET') {
      const datasetId = await resolveDatasetId(req);
      const { companyId } = req.query;
      let query = supabase.from('crm_activities').select('*').eq('dataset_id', datasetId).order('created_at', { ascending: false });
      if (companyId) query = query.eq('company_id', companyId);

      const { data, error } = await query;
      if (error) throw error;
      return res.status(200).json(data || []);
    }

    if (req.method === 'POST') {
      const datasetId = await resolveDatasetId(req);
      const { company_id, contact_id, activity_type, title, description, source, metadata } = req.body;
      const { data, error } = await supabase
        .from('crm_activities')
        .insert({
          dataset_id: datasetId,
          company_id: company_id || null,
          contact_id: contact_id || null,
          activity_type: activity_type || 'NOTE_ADDED',
          title: title || 'Human Operator Note',
          description: description || '',
          source: source || 'USER_PROVIDED',
          metadata: metadata || {},
          created_at: new Date().toISOString()
        })
        .select()
        .single();

      if (error) throw error;
      return res.status(201).json(data);
    }

    res.status(405).json({ error: 'Method not allowed' });
  } catch (err) {
    console.error(`[CRM] request failed code=${err.code || 'DATABASE_ERROR'}`);
    return apiErrorResponse(res, err, 'CRM_ERROR');
  }
}

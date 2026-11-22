export async function persistSupervisorResearch({ database, provider, datasetId, companyId }) {
  const { data } = await provider.performResearch(datasetId, { id: companyId, name: '' });
  if (!data || !['COMPLETED', 'NO_EVIDENCE'].includes(data.status)) {
    throw Object.assign(new Error('Research provider did not return a completed result.'), {
      code: data?.status === 'NOT_CONFIGURED' ? 'RESEARCH_PROVIDER_NOT_CONFIGURED' : 'RESEARCH_PROVIDER_FAILED'
    });
  }
  const { error } = await database.from('web_research').upsert({
    dataset_id: datasetId,
    company_id: companyId,
    result: data,
    updated_at: new Date().toISOString()
  }, { onConflict: 'dataset_id,company_id' });

  if (error) throw error;
  return 1;
}

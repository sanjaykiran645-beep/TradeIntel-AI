export const DATASET_OWNED_TABLES_IN_DELETE_ORDER = Object.freeze([
  'follow_up_queue',
  'response_drafts',
  'inbox_messages',
  'outreach_emails',
  'leads',
  'company_potential',
  'web_research',
  'crm_activities',
  'contacts',
  'normalized_records',
  'raw_records',
  'companies',
  'products',
  'markets',
  'agent_runs'
]);

const PROTECTED_DATASET_IDS = new Set([9]);

export function isProtectedDatasetId(value) {
  return PROTECTED_DATASET_IDS.has(Number(value));
}

const RETRYABLE_CODES = new Set(['DATABASE_UNAVAILABLE', 'DATABASE_TIMEOUT', '57P01', '57P03', '08000', '08003', '08006', 'ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT']);

function sleep(milliseconds) {
  return new Promise(resolve => setTimeout(resolve, milliseconds));
}

async function deleteInboxLinkedResponseDrafts(client, datasetId, batchSize, beforeBatch, onBatch) {
  let deleted = 0;
  let offset = 0;
  while (true) {
    const { data: messages, error: messageError } = await client.from('inbox_messages')
      .select('id')
      .eq('dataset_id', datasetId)
      .order('id', { ascending: true })
      .range(offset, offset + batchSize - 1);
    if (messageError) throw messageError;
    const messageIds = (messages || []).map(row => row.id).filter(id => id !== null && id !== undefined);
    if (!messageIds.length) break;
    offset += messageIds.length;

    while (true) {
      const { data: drafts, error: draftReadError } = await client.from('response_drafts')
        .select('id')
        .in('inbox_message_id', messageIds)
        .is('dataset_id', null)
        .order('id', { ascending: true })
        .limit(batchSize);
      if (draftReadError) throw draftReadError;
      const draftIds = (drafts || []).map(row => row.id).filter(id => id !== null && id !== undefined);
      if (!draftIds.length) break;
      if (typeof beforeBatch === 'function') await beforeBatch({ table: 'response_drafts', ids: draftIds });
      const { data: removed, error: deleteError } = await client.from('response_drafts')
        .delete()
        .in('id', draftIds)
        .is('dataset_id', null)
        .select('id');
      if (deleteError) throw deleteError;
      const count = removed?.length || 0;
      deleted += count;
      if (typeof onBatch === 'function') await onBatch({ table: 'response_drafts', deleted: count, tableDeleted: deleted });
      if (!count) {
        const remaining = await client.from('response_drafts').select('id', { count: 'exact', head: true })
          .in('inbox_message_id', messageIds).is('dataset_id', null);
        if (remaining.error) throw remaining.error;
        if (remaining.count) throw Object.assign(new Error(`Deleting response drafts linked to dataset ${datasetId} made no progress.`), { code: 'DATASET_DELETE_NO_PROGRESS' });
        break;
      }
    }
  }
  return deleted;
}

async function countInboxLinkedResponseDrafts(client, datasetId, batchSize) {
  let count = 0;
  let offset = 0;
  while (true) {
    const { data: messages, error } = await client.from('inbox_messages')
      .select('id')
      .eq('dataset_id', datasetId)
      .order('id', { ascending: true })
      .range(offset, offset + batchSize - 1);
    if (error) throw error;
    const ids = (messages || []).map(row => row.id).filter(id => id !== null && id !== undefined);
    if (!ids.length) break;
    offset += ids.length;
    const linked = await client.from('response_drafts').select('id', { count: 'exact', head: true }).in('inbox_message_id', ids);
    if (linked.error) throw linked.error;
    count += Number(linked.count || 0);
  }
  return count;
}

export async function deleteDatasetOwnedRows(client, datasetId, { batchSize = 500, beforeBatch = null, onBatch = null } = {}) {
  const id = Number(datasetId);
  if (!Number.isSafeInteger(id) || id <= 0) throw Object.assign(new Error('A positive dataset id is required for dataset-owned cleanup.'), { code: 'INVALID_DATASET_ID' });
  if (isProtectedDatasetId(id)) throw Object.assign(new Error(`Dataset ${id} is protected from deletion.`), { code: 'DATASET_PROTECTED', status: 409 });
  const deletedByTable = {};

  for (const table of DATASET_OWNED_TABLES_IN_DELETE_ORDER) {
    let tableDeleted = 0;
    while (true) {
      const { data: page, error: readError } = await client.from(table)
        .select('id')
        .eq('dataset_id', id)
        .order('id', { ascending: true })
        .limit(batchSize);
      if (readError) {
        readError.partialRowsDeletedByTable = { ...deletedByTable };
        throw readError;
      }
      const ids = (page || []).map(row => row.id).filter(value => value !== null && value !== undefined);
      if (!ids.length) break;
      if (typeof beforeBatch === 'function') await beforeBatch({ table, ids });

      let deleteResult;
      for (let attempt = 0; attempt <= 1; attempt += 1) {
        deleteResult = await client.from(table)
          .delete()
          .eq('dataset_id', id)
          .in('id', ids)
          .select('id');
        if (!deleteResult.error) break;
        if (!RETRYABLE_CODES.has(String(deleteResult.error.code || '').toUpperCase()) || attempt === 1) break;
        await sleep(200);
      }
      const { data: deleted, error: deleteError } = deleteResult;
      if (deleteError) {
        deleteError.partialRowsDeletedByTable = { ...deletedByTable, [table]: tableDeleted };
        throw deleteError;
      }
      const count = deleted?.length || 0;
      tableDeleted += count;
      if (typeof onBatch === 'function') await onBatch({ table, deleted: count, tableDeleted });
      if (!count) {
        const remaining = await client.from(table).select('id', { count: 'exact', head: true }).eq('dataset_id', id);
        if (remaining.error) throw remaining.error;
        if (remaining.count) throw Object.assign(new Error(`Deleting ${table} made no progress for dataset ${id}.`), { code: 'DATASET_DELETE_NO_PROGRESS' });
        break;
      }
    }
    if (table === 'response_drafts') {
      const linkedDraftsDeleted = await deleteInboxLinkedResponseDrafts(client, id, batchSize, beforeBatch, onBatch);
      tableDeleted += linkedDraftsDeleted;
    }
    deletedByTable[table] = tableDeleted;
  }

  const remainingByTable = {};
  for (const table of DATASET_OWNED_TABLES_IN_DELETE_ORDER) {
    const { count, error } = await client.from(table)
      .select('id', { count: 'exact', head: true })
      .eq('dataset_id', id);
    if (error) {
      error.partialRowsDeletedByTable = { ...deletedByTable };
      throw error;
    }
    remainingByTable[table] = Number(count || 0);
  }
  remainingByTable.response_drafts_linked_to_dataset_inbox = await countInboxLinkedResponseDrafts(client, id, batchSize);
  const remaining = Object.values(remainingByTable).some(count => count !== 0);
  if (remaining) throw Object.assign(new Error(`Dataset ${id} still has dataset-owned records after bounded deletion.`), { code: 'DATASET_DELETE_VERIFICATION_FAILED', deletedByTable, remainingByTable });
  return { deletedByTable, remainingByTable };
}

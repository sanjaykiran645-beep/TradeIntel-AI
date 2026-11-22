import supabase from '../_db-client.js';
import { apiErrorResponse, normalizeDatabaseError, setCors, logAudit, requireAuth } from '../_utils.js';
import { createHash, randomUUID } from 'node:crypto';
import { createSourceUpload, objectStorageConfigured, verifyDatasetSourceObjectOwnership, verifySourceObject } from '../_object-storage.js';
import { deleteSourceObject } from '../_object-storage.js';
import { prepareDatasetSourceObjectCleanup } from '../_dataset-storage-cleanup.js';
import { datasetStateConflict, filterDatasetStateVersion, nextDatasetStateVersion } from '../_dataset-state-version.js';
import { deleteDatasetOwnedRows, isProtectedDatasetId } from '../_dataset-delete.js';
import { cleanupCompletedAnalysisDatasets, isCompletedAnalysis, isSupabaseDatabaseTarget } from '../_dataset-retention.js';
import { parseOptionalTradeNumber } from '../_trade-evidence.js';

/*
 * ============================================================
 * TRADEINTEL AI - DATASET IMPORTER
 * ============================================================
 *
 * IMPORTANT:
 *
 * This endpoint is responsible for:
 *
 * 1. Receiving the complete uploaded dataset
 * 2. Recognizing the actual trade-data columns
 * 3. Creating the dataset record
 * 4. Saving ALL raw rows
 * 5. Saving normalized valid rows
 *
 * It intentionally does NOT perform expensive company/product/
 * market/lead analysis during the upload request.
 *
 * WHY?
 *
 * A 148,015-row Excel file is too large to combine with:
 *
 *   upload
 *   + normalization
 *   + company lookups
 *   + product lookups
 *   + market lookups
 *   + potential scoring
 *   + lead creation
 *   + CRM logging
 *
 * in one HTTP request.
 *
 * The previous implementation caused:
 *
 *   cancelling statement due to statement timeout
 *
 * This implementation separates IMPORT from ANALYSIS.
 *
 * There is NO 500-row limit.
 * ============================================================
 */


/*
 * ============================================================
 * IMPORT CONFIGURATION
 * ============================================================
 *
 * Smaller batches prevent one PostgreSQL statement from becoming
 * too large or running for too long.
 *
 * If a batch still times out, the importer automatically retries
 * it with a smaller batch.
 */
const INITIAL_BATCH_SIZE = 500;
const MIN_BATCH_SIZE = 100;
const MAX_CONCURRENT_BATCHES = 3;
const MAX_BATCH_RETRIES = 2;
const SOURCE_FILE_TYPES = Object.freeze({
  csv: 'text/csv',
  xls: 'application/vnd.ms-excel',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  json: 'application/json'
});

export function getSupportedImportFileType(filename) {
  const extension = String(filename || '').trim().split('.').pop()?.toLowerCase();
  return Object.hasOwn(SOURCE_FILE_TYPES, extension) ? extension : null;
}


/*
 * ============================================================
 * BASIC HELPERS
 * ============================================================
 */

function cleanString(value, fallback = '') {
  if (
    value === null ||
    value === undefined
  ) {
    return fallback;
  }

  return String(value).trim();
}


function firstValue(row, keys, fallback = '') {
  if (!row || typeof row !== 'object') {
    return fallback;
  }

  for (const key of keys) {
    const value = row[key];

    if (
      value !== undefined &&
      value !== null &&
      String(value).trim() !== ''
    ) {
      return value;
    }
  }

  return fallback;
}


function sourceRowHash(row) {
  const canonical = row && typeof row === 'object' && !Array.isArray(row)
    ? Object.fromEntries(Object.keys(row).sort().map(key => [key, row[key]]))
    : row;
  return createHash('sha256').update(JSON.stringify(canonical) ?? 'null').digest('hex');
}


function dateValue(value) {
  if (!value) {
    return null;
  }

  if (
    value instanceof Date &&
    !Number.isNaN(value.getTime())
  ) {
    return value.toISOString().split('T')[0];
  }

  const text = String(value).trim();

  if (!text) {
    return null;
  }

  const date = new Date(text);

  if (Number.isNaN(date.getTime())) {
    return null;
  }

  return date.toISOString().split('T')[0];
}


function isTimeoutError(error) {
  const message = String(
    error?.message || ''
  ).toLowerCase();

  const code = String(
    error?.code || ''
  ).toLowerCase();

  return (
    code === '57014' ||
    message.includes('statement timeout') ||
    message.includes('canceling statement') ||
    message.includes('cancelling statement')
  );
}


/*
 * ============================================================
 * SLEEP
 * ============================================================
 */

function sleep(ms) {
  return new Promise(resolve => {
    setTimeout(resolve, ms);
  });
}


/*
 * ============================================================
 * DATABASE BATCH INSERT
 * ============================================================
 *
 * Inserts records in controlled batches.
 *
 * IMPORTANT:
 *
 * This is NOT a data limit.
 *
 * 148,015 records means:
 *
 *     148,015 records
 *          ↓
 *     multiple database batches
 *
 * ALL records are processed.
 */
async function insertBatches(
  tableName,
  records,
  initialBatchSize = INITIAL_BATCH_SIZE
) {
  if (
    !Array.isArray(records) ||
    records.length === 0
  ) {
    return {
      inserted: 0,
      batches: 0
    };
  }

  let batchSize = initialBatchSize;
  let inserted = 0;
  let batches = 0;

  let index = 0;

  while (index < records.length) {
    const batch = records.slice(
      index,
      index + batchSize
    );

    let attempt = 0;
    let completed = false;

    while (
      !completed &&
      attempt <= MAX_BATCH_RETRIES
    ) {
      try {
        const { error } = await supabase
          .from(tableName)
          .insert(
            batch,
            {
              defaultToNull: false
            }
          );

        if (error) {
          throw error;
        }

        completed = true;

      } catch (error) {
        attempt += 1;

        /*
         * If PostgreSQL reports a timeout,
         * reduce the batch size and retry.
         */
        if (
          isTimeoutError(error) &&
          batchSize > MIN_BATCH_SIZE &&
          attempt <= MAX_BATCH_RETRIES
        ) {
          batchSize = Math.max(
            MIN_BATCH_SIZE,
            Math.floor(batchSize / 2)
          );

          console.warn(
            `[DATASET IMPORT] ${tableName} batch timeout. ` +
            `Retrying with batch size ${batchSize}.`
          );

          /*
           * Recreate the smaller batch from the same
           * starting position.
           */
          break;
        }

        throw error;
      }
    }

    if (!completed) {
      /*
       * The loop will retry from the same index using
       * the smaller batch size.
       */
      continue;
    }

    inserted += batch.length;
    batches += 1;
    index += batch.length;

    /*
     * Give the database a very small breathing period
     * between batches.
     */
    await sleep(10);
  }

  return {
    inserted,
    batches
  };
}


/*
 * ============================================================
 * CONCURRENT BATCH QUEUE
 * ============================================================
 *
 * Runs a limited number of batch operations concurrently.
 *
 * This reduces total wall-clock time without opening
 * hundreds of simultaneous database requests.
 */
async function insertBatchAdaptive(tableName, batch, timeoutRetries = MAX_BATCH_RETRIES) {
  const { error } = await supabase
    .from(tableName)
    .insert(batch, { defaultToNull: false });

  if (!error) {
    // The caller only needs the confirmed row count; returning every inserted id
    // adds an unnecessary response payload for large imports.
    return { inserted: batch.length, batches: 1 };
  }

  if (!isTimeoutError(error)) throw error;

  if (batch.length > MIN_BATCH_SIZE && timeoutRetries > 0) {
    const smallerSize = Math.max(MIN_BATCH_SIZE, Math.floor(batch.length / 2));
    let inserted = 0;
    let batches = 0;
    try {
      for (let start = 0; start < batch.length; start += smallerSize) {
        const result = await insertBatchAdaptive(
          tableName,
          batch.slice(start, start + smallerSize),
          timeoutRetries - 1
        );
        inserted += result.inserted;
        batches += result.batches;
      }
    } catch (error) {
      error.partialBatchInserted =
        (error.partialBatchInserted || 0) + inserted;
      throw error;
    }
    return { inserted, batches };
  }

  if (timeoutRetries > 0) {
    await sleep(250);
    return insertBatchAdaptive(tableName, batch, timeoutRetries - 1);
  }

  throw error;
}

async function insertBatchesConcurrent(tableName, records, batchSize = INITIAL_BATCH_SIZE) {
  if (!Array.isArray(records) || records.length === 0) {
    return { attempted: 0, inserted: 0, alreadyExisting: 0, failed: 0, batches: 0 };
  }

  const batches = [];
  for (let start = 0; start < records.length; start += batchSize) {
    batches.push(records.slice(start, start + batchSize));
  }

  let nextIndex = 0;
  let attempted = 0;
  let inserted = 0;
  let completedBatches = 0;
  let failedBatchRows = 0;
  let stopped = false;

  async function worker() {
    while (!stopped) {
      const currentIndex = nextIndex++;
      if (currentIndex >= batches.length) return;

      const batch = batches[currentIndex];
      attempted += batch.length;
      try {
        const result = await insertBatchAdaptive(tableName, batch);
        inserted += result.inserted;
        completedBatches += result.batches;
        await sleep(10);
      } catch (error) {
        const partialInserted = error.partialBatchInserted || 0;
        inserted += partialInserted;
        failedBatchRows += Math.max(0, batch.length - partialInserted);
        stopped = true;
        throw error;
      }
    }
  }

  const workerCount = Math.min(MAX_CONCURRENT_BATCHES, batches.length);
  const workerResults = await Promise.allSettled(
    Array.from({ length: workerCount }, () => worker())
  );
  const failedWorker = workerResults.find(result => result.status === 'rejected');

  if (failedWorker) {
    const error = failedWorker.reason;
    error.importBatchAccounting = {
      attempted,
      inserted,
      alreadyExisting: 0,
      failed: failedBatchRows,
      unattempted: records.length - attempted,
      batches: completedBatches
    };
    throw error;
  }

  return {
    attempted,
    inserted,
    alreadyExisting: 0,
    failed: 0,
    batches: completedBatches
  };
}

/*
 * ============================================================
 * DATA NORMALIZATION
 * ============================================================
 *
 * Recognizes the REAL columns from the user's Excel file.
 *
 * Known columns include:
 *
 * Period
 * Type
 * Month
 * Port of Loading
 * Mode of Shipment
 * Port_Code
 * Sbill_No
 * Sbill_Date
 * RITC_Code
 * Item_Description
 * Quantity
 * UQC
 * Unit Rate in FC
 * Currency
 * Total FOB Value in INR
 * INVOICE_NO
 * PORT_CD
 * COUNTRY
 * Consignee Name
 * Consignee Address
 * CHA_Name
 * IEC
 * Exporter_Name
 * Exporter_Address
 * Exporter_City_State
 * Exporter_PIN
 * Exporter_Phone
 * Exporter_mail
 * Exporter_Contact_Person_1
 * Exporter_Contact_Person_2
 * IEC_Date_of_Establishment
 * IEC_PAN
 */
export function normalizeRow(
  row,
  rowIndex,
  importTimestamp
) {
  const company = cleanString(
    firstValue(
      row,
      [
        'Consignee Name',
        'consignee_name',
        'Importer Name',
        'importer_name',
        'Importer',
        'importer',
        'Buyer Name',
        'buyer_name',
        'Buyer',
        'buyer',
        'Company Name',
        'company_name',
        'Company',
        'company'
      ]
    )
  );

  const product = cleanString(
    firstValue(
      row,
      [
        'Item_Description',
        'Item Description',
        'item_description',
        'Product Description',
        'product_description',
        'Product Name',
        'product_name',
        'Product',
        'product',
        'Commodity',
        'commodity',
        'Item',
        'item'
      ]
    )
  );

  const country = cleanString(
    firstValue(
      row,
      [
        'COUNTRY',
        'Country',
        'country',
        'Destination Country',
        'destination_country',
        'Market',
        'market'
      ],
      'Unknown'
    )
  ) || 'Unknown';

  const quantity = parseOptionalTradeNumber(
    firstValue(
      row,
      [
        'Quantity',
        'quantity',
        'Qty',
        'qty',
        'Volume',
        'volume'
      ]
    )
  );

  const valueAmount = parseOptionalTradeNumber(
    firstValue(
      row,
      [
        'Total FOB Value in INR',
        'Total FOB Value',
        'total_fob_value_in_inr',
        'FOB Value',
        'fob_value',
        'Trade Value',
        'trade_value',
        'Value',
        'value',
        'Amount',
        'amount',
        'Revenue',
        'revenue'
      ]
    )
  );

  const explicitInrValue = ['Total FOB Value in INR', 'total_fob_value_in_inr'].some(key =>
    row?.[key] !== undefined && row?.[key] !== null && String(row[key]).trim() !== ''
  );
  const currency = cleanString(firstValue(row, ['Currency', 'currency'])) || (explicitInrValue ? 'INR' : null);

  const transactionDate = dateValue(
    firstValue(
      row,
      [
        'Sbill_Date',
        'Sbill Date',
        'sbill_date',
        'Date',
        'date',
        'Transaction Date',
        'transaction_date',
        'Order Date',
        'order_date'
      ]
    )
  );

  const unit = cleanString(
    firstValue(
      row,
      [
        'UQC',
        'uqc',
        'Unit',
        'unit'
      ]
    )
  ) || null;

  const hsCode = cleanString(
    firstValue(
      row,
      [
        'RITC_Code',
        'RITC Code',
        'ritc_code',
        'HS Code',
        'HS_Code',
        'hs_code'
      ]
    )
  );

  const errors = [];

  if (!company) {
    errors.push(
      'Missing company name'
    );
  }

  if (!product) {
    errors.push(
      'Missing product description'
    );
  }

  const isValid =
    errors.length === 0;

  /*
   * Keep the original row completely intact.
   */
  const rawRecord = {
    row_index: rowIndex,
    raw_data: row,
    errors,
    is_valid: isValid,
    is_duplicate: false,
    duplicate_of_row_index: null,
    raw_hash: sourceRowHash(row),
    created_at: importTimestamp
  };

  /*
   * Only valid rows go into normalized_records.
   */
  const normalizedRecord = isValid
    ? {
        company_name: company,
        product_name: product,
        category: 'Trade',
        role: 'buyer',
        country,
        quantity,
        unit,
        value_amount: valueAmount,
        currency,
        transaction_date:
          transactionDate,
        _sourceRowIndex: rowIndex,
        created_at:
          importTimestamp
      }
    : null;

  return {
    rawRecord,
    normalizedRecord,
    isValid
  };
}


/*
 * ============================================================
 * GET DATASETS
 * ============================================================
 */
async function getDatasets(req, res) {
  const {
    data,
    error
  } = await supabase
    .from('datasets')
    .select('*')
    .order(
      'id',
      {
        ascending: false
      }
    );

  if (error) {
    throw error;
  }

  return res
    .status(200)
    .json(
      data || []
    );
}


/*
 * ============================================================
 * CREATE DATASET
 * ============================================================
 */
async function createDataset({
  filename,
  fileType,
  totalRows,
  validRows,
  duplicateRows = 0,
  errorRows,
  columns,
  companiesCount,
  productsCount,
  marketsCount,
  importTimestamp,
  contentHash,
  storageKey = null,
  originalSizeBytes = null,
  sourceFileStorageStatus = 'NOT_CONFIGURED'
}) {
  const {
    data,
    error
  } = await supabase
    .from('datasets')
    .insert({
      filename,
      file_type: fileType,
      content_hash: contentHash || null,
      storage_key: storageKey,
      original_size_bytes: originalSizeBytes,
      uploaded_at: storageKey ? importTimestamp : null,
      total_rows: totalRows,
      valid_rows: validRows,
      duplicate_rows: duplicateRows,
      error_rows: errorRows,
      column_mapping: columns,
      detected_entities: {
        companiesCount,
        productsCount,
        marketsCount,
        import: {
          status: 'RUNNING',
          contentHash,
          uploadHash: contentHash,
          sourceFileStorageStatus: storageKey ? 'STORED' : sourceFileStorageStatus,
          expectedRows: totalRows,
          nextRowIndex: 0,
          activeBatchToken: null,
          startedAt: importTimestamp,
          updatedAt: importTimestamp
        }
      },

      status: 'IMPORTING',
      import_status: 'RUNNING',
      analysis_status: 'QUEUED',

      created_at:
        importTimestamp
    })
    .select()
    .single();

  if (error) {
    throw error;
  }

  return data;
}

async function updateDatasetImportState(dataset, importState) {
  const entities = dataset.detected_entities && typeof dataset.detected_entities === 'object'
    ? dataset.detected_entities
    : {};
  const completedCounts = importState?.status === 'COMPLETED' ? importState.actualCounts : null;
  const updatedAt = nextDatasetStateVersion(dataset.updated_at);
  let update = supabase
    .from('datasets')
    .update({
      detected_entities: { ...entities, import: importState },
      updated_at: updatedAt,
      ...(completedCounts ? {
        valid_rows: completedCounts.validRows,
        duplicate_rows: completedCounts.duplicateRows,
        error_rows: completedCounts.errorRows,
        import_status: 'COMPLETED',
        status: 'IMPORTED'
      } : {})
    })
    .eq('id', dataset.id);
  update = filterDatasetStateVersion(update, dataset.updated_at);
  const { data, error } = await update
    .select('id,filename,file_type,total_rows,valid_rows,duplicate_rows,error_rows,column_mapping,detected_entities,status,created_at,import_status,analysis_status,updated_at')
    .maybeSingle();
  if (error) throw error;
  if (!data) throw datasetStateConflict(dataset.id);
  return data;
}

async function finishReplacementCleanup(dataset) {
  let result;
  if (!isCompletedAnalysis(dataset)) {
    result = {
      status: 'WAITING_FOR_ANALYSIS',
      updatedAt: new Date().toISOString(),
      reason: 'The verified import is retained with prior analyses until its core analysis stages complete.'
    };
  } else {
    try {
      result = await cleanupCompletedAnalysisDatasets(dataset.id);
    } catch (error) {
      result = {
        status: 'FAILED',
        updatedAt: new Date().toISOString(),
        error: error.message || error.code || 'Previous analysis cleanup failed.'
      };
    }
  }

  const importState = dataset.detected_entities?.import || {};
  const updatedImport = { ...importState, replacementCleanup: result, updatedAt: new Date().toISOString() };
  try {
    const saved = await updateDatasetImportState(dataset, updatedImport);
    return { dataset: saved, result };
  } catch (error) {
    return {
      dataset,
      result: {
        ...result,
        status: 'STATE_PERSISTENCE_FAILED',
        persistenceError: error.message || error.code || 'Replacement cleanup state could not be persisted.'
      }
    };
  }
}

function analysisReadyAfterImport() {
  // Retention is deferred until analysis succeeds; it must never block analysis.
  return true;
}

async function deleteDatasetRows(datasetId) {
  if (isProtectedDatasetId(datasetId)) {
    throw Object.assign(new Error('Dataset 9 is protected during this audit fix.'), { code: 'DATASET_PROTECTED', status: 409 });
  }
  if (isSupabaseDatabaseTarget()) {
    throw Object.assign(new Error('Dataset-owned data deletion is disabled for Supabase database hosts.'), { code: 'SUPABASE_DATABASE_PROTECTED' });
  }
  return deleteDatasetOwnedRows(supabase, datasetId, { batchSize: INITIAL_BATCH_SIZE });
}

async function findDatasetByImportHash(contentHash) {
  const { data, error } = await supabase
    .from('datasets')
    .select('id,filename,file_type,total_rows,valid_rows,duplicate_rows,error_rows,column_mapping,detected_entities,status,created_at,storage_key,original_size_bytes,import_status,analysis_status,updated_at')
    .eq('content_hash', contentHash)
    .maybeSingle();
  if (error) throw error;
  return data;
}

function isImportStale(importState, dataset) {
  if (!importState || importState.status !== 'RUNNING') return false;
  const activeExpires = Date.parse(importState.activeBatchExpiresAt || '');
  if (!Number.isNaN(activeExpires) && activeExpires < Date.now()) return true;
  const updatedTime = Date.parse(importState.updatedAt || dataset?.updated_at || '');
  if (!Number.isNaN(updatedTime) && (Date.now() - updatedTime > 5 * 60 * 1000)) return true;
  return false;
}

async function deletePartialImportRows(datasetId) {
  try {
    await supabase.from('normalized_records').delete().eq('dataset_id', datasetId);
    await supabase.from('raw_records').delete().eq('dataset_id', datasetId);
  } catch (err) {
    console.warn(`[DATASETS] cleanup of partial records for dataset ${datasetId}:`, err.message);
  }
}

const MAX_SOURCE_FILE_BYTES = 100 * 1024 * 1024; // 100 MB max source file size

async function prepareSourceUpload(req, res) {
  const { filename, contentHash } = req.body || {};
  const sizeBytes = Number(req.body?.sizeBytes);
  if (!String(filename || '').trim()) return res.status(400).json({ success: false, code: 'SOURCE_FILENAME_REQUIRED', error: 'A source filename is required.' });
  const sourceFileType = getSupportedImportFileType(filename);
  if (!sourceFileType) return res.status(415).json({ success: false, code: 'SOURCE_FILE_TYPE_UNSUPPORTED', error: 'Use a CSV, XLS, XLSX, or JSON file.' });
  if (!Number.isSafeInteger(sizeBytes) || sizeBytes <= 0 || sizeBytes > MAX_SOURCE_FILE_BYTES) {
    return res.status(400).json({ success: false, code: 'SOURCE_FILE_SIZE_INVALID', error: 'A valid source file size up to 100 MB is required.' });
  }
  if (!/^[a-f0-9]{64}$/i.test(String(contentHash || ''))) return res.status(400).json({ success: false, code: 'SOURCE_FILE_HASH_INVALID', error: 'A SHA-256 source file hash is required.' });

  // Confirm a real database connection before creating a presigned upload.
  const healthy = await supabase.healthcheck();
  if (!healthy) throw Object.assign(new Error('Managed PostgreSQL did not confirm a healthy query.'), { code: 'DATABASE_UNAVAILABLE', status: 503 });
  const existing = await findDatasetByImportHash(String(contentHash).toLowerCase());
  const prior = existing?.detected_entities?.import;
  if (prior?.status === 'COMPLETED') {
    return res.status(200).json({ success: true, alreadyImported: true, datasetId: existing.id, summary: importResponseSummary(existing) });
  }
  if (prior?.status === 'RUNNING') {
    const stale = isImportStale(prior, existing);
    if (stale || req.body?.restart === true || req.body?.force === true) {
      return res.status(200).json({ success: true, resume: false, restart: true, datasetId: existing.id, nextRowIndex: 0 });
    }
    return res.status(200).json({ success: true, resume: true, datasetId: existing.id, nextRowIndex: Number(prior.nextRowIndex || 0) });
  }
  if (prior?.status === 'FAILED') {
    await deletePartialImportRows(existing.id);
    return res.status(200).json({ success: true, resume: false, restart: true, datasetId: existing.id, nextRowIndex: 0, storageKey: existing.storage_key || null, originalSizeBytes: Number(existing.original_size_bytes || 0) });
  }

  if (!objectStorageConfigured) {
    return res.status(200).json({
      success: true,
      uploadRequired: false,
      sourceFileStored: false,
      sourceFileStorageStatus: 'NOT_CONFIGURED',
      message: 'Private source-file storage is not configured. Parsed source rows will still be persisted in PostgreSQL.'
    });
  }

  const upload = await createSourceUpload({ filename, contentType: SOURCE_FILE_TYPES[sourceFileType], sizeBytes, contentHash });
  return res.status(200).json({ success: true, uploadRequired: true, sourceFileStored: true, ...upload });
}

const MAX_IMPORT_CHUNK_ROWS = 1000;
const MAX_IMPORT_CHUNK_BYTES = 3 * 1024 * 1024;
const IMPORT_BATCH_LOCK_MS = 2 * 60 * 1000;

function importResponseSummary(dataset, actualCounts = null) {
  const prior = dataset.detected_entities?.import || {};
  return {
    totalRows: dataset.total_rows,
    validRows: dataset.valid_rows,
    duplicateRows: dataset.duplicate_rows || 0,
    errorRows: dataset.error_rows,
    datasetId: dataset.id,
    rawRowsInserted: actualCounts?.totalRows ?? prior.actualCounts?.totalRows ?? null,
    normalizedRowsInserted: actualCounts?.normalizedRows ?? prior.actualCounts?.normalizedRows ?? null,
    analysis: dataset.detected_entities?.pipeline?.status || 'PENDING'
  };
}

async function countImportRows(datasetId) {
  const [total, valid, duplicates, invalid, normalized] = await Promise.all([
    supabase.from('raw_records').select('id', { count: 'exact', head: true }).eq('dataset_id', datasetId),
    supabase.from('raw_records').select('id', { count: 'exact', head: true }).eq('dataset_id', datasetId).eq('is_valid', true).eq('is_duplicate', false),
    supabase.from('raw_records').select('id', { count: 'exact', head: true }).eq('dataset_id', datasetId).eq('is_duplicate', true),
    supabase.from('raw_records').select('id', { count: 'exact', head: true }).eq('dataset_id', datasetId).eq('is_valid', false),
    supabase.from('normalized_records').select('id', { count: 'exact', head: true }).eq('dataset_id', datasetId)
  ]);
  const failed = [total, valid, duplicates, invalid, normalized].find(result => result.error);
  if (failed) throw failed.error;
  return {
    totalRows: Number(total.count || 0),
    validRows: Number(valid.count || 0),
    duplicateRows: Number(duplicates.count || 0),
    errorRows: Number(invalid.count || 0),
    normalizedRows: Number(normalized.count || 0)
  };
}

async function startChunkedImport(req, res) {
  const { filename, expectedRows, columns, uploadHash, storageKey } = req.body || {};
  const originalSizeBytes = Number(req.body?.originalSizeBytes);
  if (Number.isSafeInteger(originalSizeBytes) && (originalSizeBytes <= 0 || originalSizeBytes > MAX_SOURCE_FILE_BYTES)) {
    return res.status(400).json({ success: false, error: 'Source file size exceeds the maximum allowed limit of 100 MB.', code: 'SOURCE_FILE_SIZE_INVALID' });
  }
  const totalRows = Number(expectedRows);
  const sourceFileType = getSupportedImportFileType(filename);
  if (!sourceFileType) return res.status(415).json({ success: false, error: 'Use a CSV, XLS, XLSX, or JSON file.', code: 'SOURCE_FILE_TYPE_UNSUPPORTED' });
  if (!Number.isSafeInteger(totalRows) || totalRows <= 0) {
    return res.status(400).json({ success: false, error: 'expectedRows must be a positive integer.', code: 'IMPORT_ROW_COUNT_REQUIRED' });
  }
  if (!/^[a-f0-9]{64}$/i.test(String(uploadHash || ''))) {
    return res.status(400).json({ success: false, error: 'A SHA-256 uploadHash is required for resumable import.', code: 'IMPORT_HASH_REQUIRED' });
  }
  if (!Array.isArray(columns) || columns.some(column => typeof column !== 'string')) {
    return res.status(400).json({ success: false, error: 'The source column list is invalid.', code: 'IMPORT_COLUMNS_INVALID' });
  }

  const matching = await findDatasetByImportHash(uploadHash);
  if (matching?.detected_entities?.import?.status === 'COMPLETED') {
    const previousCleanup = matching.detected_entities.import.replacementCleanup;
    const replacement = previousCleanup?.status === 'COMPLETED'
      ? { dataset: matching, result: previousCleanup }
      : await finishReplacementCleanup(matching);
    return res.status(200).json({
      success: true,
      duplicateRequest: true,
      datasetId: matching.id,
      summary: importResponseSummary(replacement.dataset),
      retention: replacement.result,
      analysisReady: analysisReadyAfterImport(replacement.result),
      message: `This exact file was already imported as dataset ${matching.id}; no rows were written.`
    });
  }
  if (matching?.detected_entities?.import?.status === 'RUNNING') {
    const importState = matching.detected_entities.import;
    const rowMismatch = Number(matching.total_rows) !== totalRows;
    const stale = isImportStale(importState, matching);
    const forceRestart = req.body?.restart === true || req.body?.force === true;

    if (rowMismatch || stale || forceRestart) {
      await deletePartialImportRows(matching.id);
      const nextState = {
        ...importState,
        status: 'RUNNING',
        uploadHash,
        expectedRows: totalRows,
        nextRowIndex: 0,
        processedRows: 0,
        activeBatchToken: null,
        activeBatchHash: null,
        activeBatchExpiresAt: null,
        startedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        error: null
      };
      const updatedAt = nextDatasetStateVersion(matching.updated_at);
      let update = supabase.from('datasets')
        .update({
          total_rows: totalRows,
          valid_rows: 0,
          duplicate_rows: 0,
          error_rows: 0,
          storage_key: storageKey || matching.storage_key || null,
          original_size_bytes: originalSizeBytes || matching.original_size_bytes || null,
          import_status: 'RUNNING',
          status: 'IMPORTING',
          column_mapping: columns,
          detected_entities: { ...(matching.detected_entities || {}), import: nextState },
          updated_at: updatedAt
        })
        .eq('id', matching.id);
      update = filterDatasetStateVersion(update, matching.updated_at);
      const { data, error } = await update
        .select('id,filename,file_type,total_rows,valid_rows,error_rows,column_mapping,detected_entities,status,created_at,updated_at')
        .maybeSingle();
      if (error) throw error;
      return res.status(200).json({
        success: true,
        resumed: false,
        restarted: true,
        datasetId: matching.id,
        nextRowIndex: 0,
        message: rowMismatch
          ? `Incomplete import ${matching.id} had a different row count (${matching.total_rows} vs ${totalRows}); restarting cleanly from row 1.`
          : `Restarted import ${matching.id} from row 1.`
      });
    }

    return res.status(200).json({
      success: true,
      resumed: true,
      datasetId: matching.id,
      nextRowIndex: Number(importState.nextRowIndex || 0),
      message: `Resuming persisted import ${matching.id} from source row ${Number(importState.nextRowIndex || 0) + 1}.`
    });
  }
  if (!Number.isSafeInteger(originalSizeBytes) || originalSizeBytes <= 0) {
    return res.status(400).json({ success: false, error: 'A positive original source file size is required.', code: 'SOURCE_FILE_SIZE_INVALID' });
  }
  if (objectStorageConfigured && !storageKey) {
    return res.status(400).json({ success: false, error: 'A verified original source file object and its byte size are required.', code: 'SOURCE_OBJECT_REQUIRED' });
  }
  if (storageKey && !objectStorageConfigured) {
    return res.status(503).json({ success: false, error: 'Private source-file storage is not configured; retry without a storage key.', code: 'OBJECT_STORAGE_NOT_CONFIGURED' });
  }
  const storedObject = storageKey
    ? await verifySourceObject({ storageKey, sizeBytes: originalSizeBytes, contentHash: uploadHash })
    : null;
  if (matching?.detected_entities?.import?.status === 'FAILED') {
    const prior = matching.detected_entities.import;
    await deletePartialImportRows(matching.id);
    const nextState = {
      ...prior,
      cleanup: { status: 'COMPLETED', cleanedAt: new Date().toISOString() },
      status: 'RUNNING',
      uploadHash,
      expectedRows: totalRows,
      nextRowIndex: 0,
      activeBatchToken: null,
      activeBatchHash: null,
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      error: null
    };
    const updatedAt = nextDatasetStateVersion(matching.updated_at);
    let update = supabase.from('datasets')
      .update({ total_rows: totalRows, valid_rows: 0, duplicate_rows: 0, error_rows: 0, storage_key: storageKey || null, original_size_bytes: storedObject?.sizeBytes || null, uploaded_at: storedObject ? new Date().toISOString() : null, import_status: 'RUNNING', status: 'IMPORTING', column_mapping: columns, detected_entities: { ...(matching.detected_entities || {}), import: { ...nextState, sourceFileStorageStatus: storedObject ? 'STORED' : 'NOT_CONFIGURED' } }, updated_at: updatedAt })
      .eq('id', matching.id);
    update = filterDatasetStateVersion(update, matching.updated_at);
    const { data, error } = await update
      .select('id,filename,file_type,total_rows,valid_rows,error_rows,column_mapping,detected_entities,status,created_at,updated_at')
      .maybeSingle();
    if (error) throw error;
    if (!data) throw datasetStateConflict(matching.id);
    return res.status(200).json({ success: true, resumed: true, datasetId: data.id, nextRowIndex: 0 });
  }

  const startedAt = new Date().toISOString();
  const dataset = await createDataset({
    filename: cleanString(filename, 'import_data.csv'),
    fileType: sourceFileType,
    totalRows,
    validRows: 0,
    duplicateRows: 0,
    errorRows: 0,
    columns,
    companiesCount: 0,
    productsCount: 0,
    marketsCount: 0,
    importTimestamp: startedAt,
    contentHash: uploadHash,
    storageKey,
    originalSizeBytes: storedObject?.sizeBytes || null,
    sourceFileStorageStatus: storedObject ? 'STORED' : 'NOT_CONFIGURED'
  });
  return res.status(201).json({ success: true, datasetId: dataset.id, nextRowIndex: 0, message: `Import ${dataset.id} started.` });
}

async function readExistingRawIndexes(datasetId, startRowIndex, rowsLength) {
  const { data, error } = await supabase.from('raw_records')
    .select('row_index')
    .eq('dataset_id', datasetId)
    .gte('row_index', startRowIndex + 1)
    .lte('row_index', startRowIndex + rowsLength)
    .order('row_index', { ascending: true })
    .range(0, rowsLength - 1);
  if (error) throw error;
  return new Set((data || []).map(row => Number(row.row_index)));
}

const DUPLICATE_LOOKUP_BATCH_SIZE = 100;
const DUPLICATE_LOOKUP_CONCURRENCY = 5;

/**
 * Looks up the first persisted row index for each source-row hash in this dataset.
 * The hash lookups were previously issued strictly one after another (about ten sequential
 * round trips for every 1,000-row chunk). They are independent read-only queries, so they now
 * run with a small bounded concurrency; results are merged deterministically by lowest row index.
 */
async function readExistingDuplicateRowIndexes(datasetId, hashes) {
  const firstRowByHash = new Map();
  const uniqueHashes = [...new Set(hashes.filter(Boolean))];
  const batches = [];
  for (let batchStart = 0; batchStart < uniqueHashes.length; batchStart += DUPLICATE_LOOKUP_BATCH_SIZE) {
    batches.push(uniqueHashes.slice(batchStart, batchStart + DUPLICATE_LOOKUP_BATCH_SIZE));
  }

  async function readBatch(batch) {
    const found = [];
    let offset = 0;
    while (true) {
      const { data, error } = await supabase.from('raw_records')
        .select('raw_hash,row_index')
        .eq('dataset_id', datasetId)
        .in('raw_hash', batch)
        .order('row_index', { ascending: true })
        .range(offset, offset + 999);
      if (error) throw error;
      const page = data || [];
      found.push(...page);
      if (page.length < 1000) break;
      offset += page.length;
    }
    return found;
  }

  let nextBatch = 0;
  async function worker() {
    const results = [];
    while (nextBatch < batches.length) {
      const batch = batches[nextBatch++];
      results.push(...await readBatch(batch));
    }
    return results;
  }
  const workerCount = Math.min(DUPLICATE_LOOKUP_CONCURRENCY, batches.length);
  const workerResults = await Promise.all(Array.from({ length: workerCount }, () => worker()));
  for (const rows of workerResults) {
    for (const row of rows) {
      const prior = firstRowByHash.get(row.raw_hash);
      if (prior === undefined || Number(row.row_index) < prior) firstRowByHash.set(row.raw_hash, Number(row.row_index));
    }
  }
  return firstRowByHash;
}

async function readExistingNormalizedHashes(datasetId, hashes) {
  const existing = new Set();
  for (let offset = 0; offset < hashes.length; offset += 100) {
    const { data, error } = await supabase.from('normalized_records')
      .select('source_hash')
      .eq('dataset_id', datasetId)
      .in('source_hash', hashes.slice(offset, offset + 100));
    if (error) throw error;
    for (const row of data || []) existing.add(row.source_hash);
  }
  return existing;
}

async function appendImportBatch(req, res) {
  const { datasetId: rawDatasetId, uploadHash, startRowIndex: rawStart, rows } = req.body || {};
  const datasetId = Number(rawDatasetId);
  const startRowIndex = Number(rawStart);
  if (!Number.isSafeInteger(datasetId) || datasetId <= 0) {
    return res.status(400).json({ success: false, error: 'A positive datasetId is required.', code: 'IMPORT_DATASET_ID_REQUIRED' });
  }
  if (!Array.isArray(rows) || rows.length === 0 || rows.length > MAX_IMPORT_CHUNK_ROWS) {
    return res.status(400).json({ success: false, error: `Each import chunk must contain between 1 and ${MAX_IMPORT_CHUNK_ROWS} rows.`, code: 'IMPORT_CHUNK_SIZE_INVALID' });
  }
  if (!Number.isSafeInteger(startRowIndex) || startRowIndex < 0) {
    return res.status(400).json({ success: false, error: 'startRowIndex must be a zero-based source row offset.', code: 'IMPORT_OFFSET_INVALID' });
  }
  const serializedBytes = Buffer.byteLength(JSON.stringify(rows), 'utf8');
  if (serializedBytes > MAX_IMPORT_CHUNK_BYTES) {
    return res.status(413).json({ success: false, error: 'The import chunk exceeds the safe request size. Retry with a smaller chunk.', code: 'IMPORT_CHUNK_TOO_LARGE' });
  }

  const { data: dataset, error: datasetError } = await supabase.from('datasets')
    .select('id,total_rows,detected_entities,updated_at')
    .eq('id', datasetId)
    .maybeSingle();
  if (datasetError) throw datasetError;
  if (!dataset) return res.status(404).json({ success: false, error: `Dataset ${datasetId} was not found.`, code: 'DATASET_NOT_FOUND' });
  const entities = dataset.detected_entities && typeof dataset.detected_entities === 'object' ? dataset.detected_entities : {};
  const prior = entities.import || {};
  if (prior.status !== 'RUNNING' || prior.uploadHash !== uploadHash) {
    return res.status(409).json({ success: false, error: 'This dataset is not an active import for the supplied file hash.', code: 'IMPORT_STATE_CONFLICT', datasetId });
  }
  const nextRowIndex = Number(prior.nextRowIndex || 0);
  if (startRowIndex !== nextRowIndex || startRowIndex + rows.length > Number(prior.expectedRows || dataset.total_rows)) {
    return res.status(409).json({ success: false, error: `Import expects source row ${nextRowIndex + 1}.`, code: 'IMPORT_OFFSET_CONFLICT', datasetId, nextRowIndex });
  }

  const batchHash = createHash('sha256').update(JSON.stringify(rows)).digest('hex');
  const activeToken = prior.activeBatchToken || null;
  const activeExpires = Date.parse(prior.activeBatchExpiresAt || '');
  const recovering = Boolean(activeToken && Number.isFinite(activeExpires) && activeExpires <= Date.now());
  if (activeToken && !recovering) {
    return res.status(409).json({ success: false, error: 'Another request is processing this import chunk. Wait for its persisted lock to expire before retrying.', code: 'IMPORT_BATCH_IN_PROGRESS', datasetId, nextRowIndex });
  }
  if (recovering && (prior.activeBatchStart !== startRowIndex || prior.activeBatchHash !== batchHash)) {
    return res.status(409).json({ success: false, error: 'The retry does not match the previously claimed import chunk.', code: 'IMPORT_BATCH_RETRY_MISMATCH', datasetId, nextRowIndex });
  }

  const token = randomUUID();
  const importClaim = {
    ...prior,
    activeBatchToken: token,
    activeBatchHash: batchHash,
    activeBatchStart: startRowIndex,
    activeBatchExpiresAt: new Date(Date.now() + IMPORT_BATCH_LOCK_MS).toISOString(),
    updatedAt: new Date().toISOString()
  };
  const claimUpdatedAt = nextDatasetStateVersion(dataset.updated_at);
  let claim = supabase.from('datasets')
    .update({ detected_entities: { ...entities, import: importClaim }, updated_at: claimUpdatedAt })
    .eq('id', datasetId);
  claim = filterDatasetStateVersion(claim, dataset.updated_at)
    .filter('detected_entities->import->>status', 'eq', 'RUNNING')
    .filter('detected_entities->import->>nextRowIndex', 'eq', String(startRowIndex));
  claim = activeToken
    ? claim.filter('detected_entities->import->>activeBatchToken', 'eq', activeToken)
    : claim.filter('detected_entities->import->>activeBatchToken', 'is', null);
  const { data: claimed, error: claimError } = await claim.select('id,updated_at').maybeSingle();
  if (claimError) throw claimError;
  if (!claimed) return res.status(409).json({ success: false, error: 'The import state changed before this chunk could be claimed.', code: 'IMPORT_STATE_CONFLICT', datasetId });
  const persistedClaimVersion = claimed.updated_at || claimUpdatedAt;

  const importTimestamp = prior.startedAt || new Date().toISOString();
  const rawRecords = [];
  const normalizedRecords = [];
  const rowHashes = rows.map(sourceRowHash);
  const firstRowByHash = await readExistingDuplicateRowIndexes(datasetId, rowHashes);
  for (let offset = 0; offset < rows.length; offset += 1) {
    const sourceRowIndex = startRowIndex + offset + 1;
    const normalized = normalizeRow(rows[offset], sourceRowIndex, importTimestamp);
    const rawHash = rowHashes[offset];
    const firstRowIndex = firstRowByHash.get(rawHash);
    if (normalized.isValid && firstRowIndex !== undefined && firstRowIndex < sourceRowIndex) {
      normalized.rawRecord.is_duplicate = true;
      normalized.rawRecord.duplicate_of_row_index = firstRowIndex;
    }
    if (firstRowIndex === undefined) firstRowByHash.set(rawHash, sourceRowIndex);
    rawRecords.push({ ...normalized.rawRecord, dataset_id: datasetId });
    if (normalized.isValid && !normalized.rawRecord.is_duplicate) {
      const { _sourceRowIndex, ...record } = normalized.normalizedRecord;
      record.source_hash = createHash('sha256').update(`${datasetId}:${_sourceRowIndex}`).digest('hex');
      record.source_row_index = _sourceRowIndex;
      normalizedRecords.push({ ...record, dataset_id: datasetId });
    }
  }

  let existingRaw = new Set();
  let existingHashes = new Set();
  if (recovering) {
    existingRaw = await readExistingRawIndexes(datasetId, startRowIndex, rows.length);
    existingHashes = await readExistingNormalizedHashes(datasetId, normalizedRecords.map(record => record.source_hash));
  }
  const missingRaw = rawRecords.filter(record => !existingRaw.has(Number(record.row_index)));
  const missingNormalized = normalizedRecords.filter(record => !existingHashes.has(record.source_hash));
  // raw_records and normalized_records have no foreign-key dependency on each other, so both
  // writes run concurrently. If either fails the chunk is not advanced; a retry reconciles by
  // row index / source hash (the `recovering` path above), so no duplicate rows can result.
  const insertResults = await Promise.allSettled([
    missingRaw.length ? insertBatchesConcurrent('raw_records', missingRaw, INITIAL_BATCH_SIZE) : Promise.resolve(null),
    missingNormalized.length ? insertBatchesConcurrent('normalized_records', missingNormalized, INITIAL_BATCH_SIZE) : Promise.resolve(null)
  ]);
  const failedInsert = insertResults.find(result => result.status === 'rejected');
  if (failedInsert) throw failedInsert.reason;

  const nextIndex = startRowIndex + rows.length;
  const finishedImport = {
    ...importClaim,
    nextRowIndex: nextIndex,
    processedRows: nextIndex,
    activeBatchToken: null,
    activeBatchHash: null,
    activeBatchStart: null,
    activeBatchExpiresAt: null,
    updatedAt: new Date().toISOString()
  };
  let finishUpdate = supabase.from('datasets')
    .update({ detected_entities: { ...entities, import: finishedImport }, updated_at: nextDatasetStateVersion(persistedClaimVersion) })
    .eq('id', datasetId);
  finishUpdate = filterDatasetStateVersion(finishUpdate, persistedClaimVersion)
    .filter('detected_entities->import->>activeBatchToken', 'eq', token);
  const { data: saved, error: stateError } = await finishUpdate
    .select('id')
    .maybeSingle();
  if (stateError) throw stateError;
  if (!saved) throw Object.assign(new Error('Rows were written but import progress could not be advanced. Retry this same chunk after the persisted lock expires.'), { code: 'IMPORT_PROGRESS_PERSISTENCE_FAILED', status: 503 });

  return res.status(200).json({ success: true, datasetId, status: 'RUNNING', nextRowIndex: nextIndex, processedRows: nextIndex, totalRows: Number(prior.expectedRows || dataset.total_rows) });
}

async function completeChunkedImport(req, res) {
  const datasetId = Number(req.body?.datasetId);
  const uploadHash = String(req.body?.uploadHash || '');
  if (!Number.isSafeInteger(datasetId) || datasetId <= 0) {
    return res.status(400).json({ success: false, error: 'A positive datasetId is required.', code: 'IMPORT_DATASET_ID_REQUIRED' });
  }
  const { data: dataset, error: readError } = await supabase.from('datasets')
    .select('id,filename,file_type,total_rows,valid_rows,error_rows,column_mapping,detected_entities,status,created_at,updated_at')
    .eq('id', datasetId)
    .maybeSingle();
  if (readError) throw readError;
  if (!dataset) return res.status(404).json({ success: false, error: `Dataset ${datasetId} was not found.`, code: 'DATASET_NOT_FOUND' });
  const entities = dataset.detected_entities && typeof dataset.detected_entities === 'object' ? dataset.detected_entities : {};
  const prior = entities.import || {};
  if (prior.status === 'COMPLETED' && prior.uploadHash === uploadHash) {
    if (prior.replacementCleanup?.status === 'COMPLETED') {
      return res.status(200).json({ success: true, duplicateRequest: true, dataset, summary: importResponseSummary(dataset), retention: prior.replacementCleanup, message: `Dataset ${datasetId} was already imported and prepared for analysis.` });
    }
    const replacement = await finishReplacementCleanup(dataset);
    return res.status(200).json({ success: true, duplicateRequest: true, dataset: replacement.dataset, summary: importResponseSummary(replacement.dataset), retention: replacement.result, message: `Dataset ${datasetId} was already imported; previous-analysis replacement was retried.` });
  }
  if (prior.status !== 'RUNNING' || prior.uploadHash !== uploadHash) {
    return res.status(409).json({ success: false, error: 'This dataset is not an active import for the supplied file hash.', code: 'IMPORT_STATE_CONFLICT', datasetId });
  }
  if (Number(prior.nextRowIndex || 0) !== Number(prior.expectedRows || dataset.total_rows) || prior.activeBatchToken) {
    return res.status(409).json({ success: false, error: 'The complete source file has not been persisted yet.', code: 'IMPORT_INCOMPLETE', datasetId, nextRowIndex: Number(prior.nextRowIndex || 0), totalRows: Number(prior.expectedRows || dataset.total_rows) });
  }

  const actualCounts = await countImportRows(datasetId);
  const expectedRows = Number(prior.expectedRows || dataset.total_rows);
  if (actualCounts.totalRows !== expectedRows || actualCounts.validRows + actualCounts.duplicateRows + actualCounts.errorRows !== expectedRows || actualCounts.normalizedRows !== actualCounts.validRows) {
    return res.status(409).json({ success: false, error: `Import count verification failed: expected ${expectedRows} raw rows, ${actualCounts.validRows} unique valid, ${actualCounts.duplicateRows} duplicate and ${actualCounts.errorRows} invalid; persisted ${actualCounts.totalRows} raw and ${actualCounts.normalizedRows} normalized.`, code: 'IMPORT_COUNT_MISMATCH', datasetId, actualCounts });
  }

  const summary = {
    totalRows: expectedRows,
    validRows: actualCounts.validRows,
    duplicateRows: actualCounts.duplicateRows,
    errorRows: actualCounts.errorRows,
    datasetId,
    rawRowsInserted: actualCounts.totalRows,
    normalizedRowsInserted: actualCounts.normalizedRows,
    analysis: 'PENDING'
  };
  const completedImport = {
    ...prior,
    status: 'COMPLETED',
    completedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    actualCounts,
    summary,
    replacementCleanup: { status: 'WAITING_FOR_ANALYSIS', startedAt: new Date().toISOString() },
    activeBatchToken: null,
    activeBatchHash: null,
    activeBatchStart: null,
    activeBatchExpiresAt: null
  };
  const completedUpdatedAt = nextDatasetStateVersion(dataset.updated_at);
  let completionUpdate = supabase.from('datasets')
    .update({ valid_rows: actualCounts.validRows, duplicate_rows: actualCounts.duplicateRows, error_rows: actualCounts.errorRows, import_status: 'COMPLETED', status: 'IMPORTED', detected_entities: { ...entities, import: completedImport }, updated_at: completedUpdatedAt })
    .eq('id', datasetId);
  completionUpdate = filterDatasetStateVersion(completionUpdate, dataset.updated_at)
    .filter('detected_entities->import->>status', 'eq', 'RUNNING')
    .filter('detected_entities->import->>uploadHash', 'eq', uploadHash);
  const { data: saved, error: updateError } = await completionUpdate
    .select('id,filename,file_type,total_rows,valid_rows,duplicate_rows,error_rows,column_mapping,detected_entities,status,created_at,import_status,analysis_status,updated_at')
    .maybeSingle();
  if (updateError) throw updateError;
  if (!saved) return res.status(409).json({ success: false, error: 'Import state changed while final counts were being saved.', code: 'IMPORT_STATE_CONFLICT', datasetId });

  const replacement = await finishReplacementCleanup(saved);

  await logAudit(req.user?.email, 'IMPORT_DATASET', 'dataset', datasetId, summary);
  return res.status(201).json({
    success: true,
    message: `Dataset imported and count-verified. ${expectedRows.toLocaleString()} source rows were reconciled; existing analysis data will be retained until this dataset's core analysis succeeds.`,
    dataset: replacement.dataset,
    summary,
    retention: replacement.result,
    analysisReady: analysisReadyAfterImport(replacement.result)
  });
}

/*
 * ============================================================
 * IMPORT DATASET
 * ============================================================
 */
async function importDataset(
  req,
  res
) {
  let datasetId = null;
  let dataset = null;
  let actualCounts = null;
  let contentHash = null;

  const body =
    req.body || {};

  const filename =
    cleanString(
      body.filename,
      'import_data.csv'
    );

  const fileType = getSupportedImportFileType(filename);

  const records =
    Array.isArray(body.rows)
      ? body.rows
      : Array.isArray(body.records)
        ? body.records
        : [];

  const userEmail = req.user?.email || null;

  /*
   * ==========================================================
   * VALIDATE INPUT
   * ==========================================================
   */

  if (!records.length) {
    return res
      .status(400)
      .json({
        success: false,
        error:
          'No data records provided in upload.',
        code:
          'NO_RECORDS'
      });
  }
  if (!fileType) {
    return res.status(415).json({
      success: false,
      error: 'Use a CSV, XLS, XLSX, or JSON file.',
      code: 'SOURCE_FILE_TYPE_UNSUPPORTED'
    });
  }

  const allRecords =
    records;

  const importTimestamp =
    new Date().toISOString();

  /*
   * ==========================================================
   * NORMALIZE EVERYTHING IN MEMORY
   * ==========================================================
   *
   * This pass does NOT contact Supabase.
   *
   * Therefore we avoid 148,015 database calls.
   */

  const rawRecords = [];
  const normalizedRecords = [];
  const contentHasher = createHash('sha256');

  const companySet =
    new Set();

  const productSet =
    new Set();

  const marketSet =
    new Set();

  let validRows = 0;
  let duplicateRows = 0;
  let errorRows = 0;
  const firstValidRowByHash = new Map();

  for (
    let index = 0;
    index < allRecords.length;
    index += 1
  ) {
    const row =
      allRecords[index];

    contentHasher.update(JSON.stringify(row) ?? 'null').update('\n');

    const normalized =
      normalizeRow(
        row,
        index + 1,
        importTimestamp
      );

    const rawHash = normalized.rawRecord.raw_hash;
    const earlierRow = firstValidRowByHash.get(rawHash);
    if (normalized.isValid && earlierRow !== undefined) {
      normalized.rawRecord.is_duplicate = true;
      normalized.rawRecord.duplicate_of_row_index = earlierRow;
      duplicateRows += 1;
    } else if (normalized.isValid) {
      firstValidRowByHash.set(rawHash, index + 1);
      validRows += 1;
    }

    rawRecords.push(normalized.rawRecord);

    if (normalized.isValid && !normalized.rawRecord.is_duplicate) {

      normalizedRecords.push(
        normalized.normalizedRecord
      );

      companySet.add(
        normalized.normalizedRecord
          .company_name
          .toLowerCase()
      );

      productSet.add(
        normalized.normalizedRecord
          .product_name
          .toLowerCase()
      );

      marketSet.add(
        normalized.normalizedRecord
          .country
          .toLowerCase()
      );
    } else if (!normalized.isValid) {
      errorRows += 1;
    }
  }

  /*
   * ==========================================================
   * COLUMNS
   * ==========================================================
   */

  const columns =
    allRecords[0]
      ? Object.keys(
          allRecords[0]
        )
      : [];

  contentHash = contentHasher.digest('hex');

  const matchingDataset = await findDatasetByImportHash(contentHash);

  if (matchingDataset?.detected_entities?.import?.status === 'COMPLETED') {
    const priorImport = matchingDataset.detected_entities.import;
    const replacement = priorImport.replacementCleanup?.status === 'COMPLETED'
      ? { dataset: matchingDataset, result: priorImport.replacementCleanup }
      : await finishReplacementCleanup(matchingDataset);
    return res.status(200).json({
      success: true,
      ok: true,
      duplicateRequest: true,
      message: `This exact dataset was already imported as dataset ${matchingDataset.id}; no duplicate rows were written.`,
      dataset: replacement.dataset,
      summary: {
        ...(priorImport.summary || {}),
        totalRows: matchingDataset.total_rows,
        validRows: matchingDataset.valid_rows,
        errorRows: matchingDataset.error_rows,
        datasetId: matchingDataset.id,
        rawRowsInserted: priorImport.actualCounts?.totalRows ?? null,
        normalizedRowsInserted: priorImport.actualCounts?.normalizedRows ?? null,
        analysis: matchingDataset.detected_entities?.pipeline?.status || 'PENDING'
      },
      retention: replacement.result,
      analysisReady: analysisReadyAfterImport(replacement.result)
    });
  }

  if (matchingDataset?.detected_entities?.import?.status === 'RUNNING') {
    return res.status(409).json({
      success: false,
      error: `An identical import is already running as dataset ${matchingDataset.id}.`,
      code: 'IMPORT_ALREADY_RUNNING',
      datasetId: matchingDataset.id
    });
  }

  if (matchingDataset?.detected_entities?.import?.status === 'FAILED') {
    const previousImport = matchingDataset.detected_entities.import;
    if (previousImport.cleanup?.status !== 'COMPLETED') {
      return res.status(409).json({
        success: false,
        error: `Identical failed import ${matchingDataset.id} cannot be retried until its partial rows are safely cleaned up.`,
        code: 'FAILED_IMPORT_CLEANUP_REQUIRED',
        datasetId: matchingDataset.id
      });
    }
    dataset = matchingDataset;
    datasetId = matchingDataset.id;
    dataset = await updateDatasetImportState(dataset, {
      ...previousImport,
      status: 'RUNNING',
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      error: null,
      cleanup: { status: 'COMPLETED', reason: 'Partial rows from the prior failed attempt were removed before retry.' }
    });
  }

  /*
   * ==========================================================
   * CREATE DATASET RECORD
   * ==========================================================
   */

  dataset = dataset || await createDataset({
      filename,
      fileType,
      totalRows:
        allRecords.length,
      validRows,
      duplicateRows,
      errorRows,
      columns,

      companiesCount:
        companySet.size,

      productsCount:
        productSet.size,

      marketsCount:
        marketSet.size,

      importTimestamp,
      contentHash
    });

  datasetId = dataset.id;

  /*
   * ==========================================================
   * ATTACH DATASET ID
   * ==========================================================
   */

  const rawRecordsWithDataset =
    rawRecords.map(
      record => ({
        ...record,
        dataset_id:
          datasetId
      })
    );

  const normalizedRecordsWithDataset =
    normalizedRecords.map(record => {
      const { _sourceRowIndex, ...normalizedRecord } = record;
      const sourceHash = createHash('sha256')
        .update(String(datasetId) + ':' + String(_sourceRowIndex))
        .digest('hex');

      return {
        ...normalizedRecord,
        dataset_id: datasetId,
        source_row_index: _sourceRowIndex,
        source_hash: sourceHash
      };
    });

  /*
   * ==========================================================
   * SAVE RAW RECORDS
   * ==========================================================
   *
   * ALL rows are saved.
   */

  try {
    console.info(
      `[DATASET IMPORT] Saving ${rawRecordsWithDataset.length.toLocaleString()} raw rows...`
    );

    const rawResult =
      await insertBatchesConcurrent(
        'raw_records',
        rawRecordsWithDataset,
        INITIAL_BATCH_SIZE
      );

    console.info(
      `[DATASET IMPORT] Raw rows saved: ${rawResult.inserted.toLocaleString()}`
    );

    /*
     * ========================================================
     * SAVE NORMALIZED RECORDS
     * ========================================================
     *
     * Only valid rows are saved here.
     */

    console.info(
      `[DATASET IMPORT] Saving ${normalizedRecordsWithDataset.length.toLocaleString()} normalized rows...`
    );

    const normalizedResult =
      await insertBatchesConcurrent(
        'normalized_records',
        normalizedRecordsWithDataset,
        INITIAL_BATCH_SIZE
      );

    console.info(
      `[DATASET IMPORT] Normalized rows saved: ${normalizedResult.inserted.toLocaleString()}`
    );

    actualCounts = await countImportRows(datasetId);

    if (
      actualCounts.totalRows !== allRecords.length ||
      actualCounts.validRows !== validRows ||
      actualCounts.duplicateRows !== duplicateRows ||
      actualCounts.errorRows !== errorRows ||
      actualCounts.normalizedRows !== normalizedRecordsWithDataset.length
    ) {
      const mismatch = new Error(
        `Import count mismatch for dataset ${datasetId}: expected raw=${allRecords.length}, valid=${validRows}, duplicate=${duplicateRows}, invalid=${errorRows}, normalized=${normalizedRecordsWithDataset.length}; database has raw=${actualCounts.totalRows}, valid=${actualCounts.validRows}, duplicate=${actualCounts.duplicateRows}, invalid=${actualCounts.errorRows}, normalized=${actualCounts.normalizedRows}.`
      );
      mismatch.code = 'IMPORT_COUNT_MISMATCH';
      throw mismatch;
    }

    const importSummary = {
      totalRows: allRecords.length,
      validRows,
      duplicateRows,
      errorRows,
      companies: companySet.size,
      products: productSet.size,
      markets: marketSet.size,
      datasetId,
      rawRowsInserted: actualCounts.totalRows,
      normalizedRowsInserted: actualCounts.normalizedRows,
      analysis: 'PENDING'
    };

    dataset = await updateDatasetImportState(dataset, {
      ...(dataset.detected_entities?.import || {}),
      status: 'COMPLETED',
      contentHash,
      completedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      actualCounts,
      summary: importSummary,
      replacementCleanup: { status: 'WAITING_FOR_ANALYSIS', startedAt: new Date().toISOString() }
    });
    const replacement = await finishReplacementCleanup(dataset);
    dataset = replacement.dataset;

    /*
     * ========================================================
     * AUDIT
     * ========================================================
     *
     * Audit is deliberately done AFTER the large data writes.
     */

    try {
      await logAudit(
        userEmail,
        'IMPORT_DATASET',
        'dataset',
        datasetId,
        {
          filename,

          totalRows:
            allRecords.length,

          validRows,

          errorRows,

          companies:
            companySet.size,

          products:
            productSet.size,

          markets:
            marketSet.size,

          rawRowsInserted: actualCounts.totalRows,
          normalizedRowsInserted: actualCounts.normalizedRows
        }
      );
    } catch (auditError) {
      /*
       * Audit failure must not make a successful data import
       * look like a failed import.
       */
      console.warn(
        '[DATASET IMPORT] Audit warning:',
        auditError?.message
      );
    }

    /*
     * ========================================================
     * RESPONSE
     * ========================================================
     *
     * IMPORTANT:
     *
     * This response says IMPORTED.
     *
     * It does NOT claim that the expensive AI analysis
     * has been completed.
     */

    return res
      .status(201)
      .json({
        success: true,
        ok: true,

        message: `Dataset imported successfully. ${allRecords.length.toLocaleString()} rows were verified; existing analysis data will be retained until this dataset's core analysis succeeds.`,

        dataset,
        summary: importSummary,
        retention: replacement.result,
        analysisReady: analysisReadyAfterImport(replacement.result)
      });

  } catch (error) {
    /*
     * ========================================================
     * IMPORT FAILURE
     * ========================================================
     */

    const normalizedError = normalizeDatabaseError(error, 'Dataset import failed.');
    console.error(`[DATASET IMPORT] Import failed dataset=${datasetId || 'uncreated'} code=${normalizedError.code}`);

    let failureCleanup = { status: 'NOT_REQUIRED' };
    if (datasetId && dataset && !normalizedError.code.startsWith('DATABASE_')) {
      const detectedEntities = dataset.detected_entities && typeof dataset.detected_entities === 'object'
        ? dataset.detected_entities
        : {};
      let failedDataset = dataset;
      const failedImport = {
        ...(detectedEntities.import || {}),
        status: 'FAILED',
        contentHash,
        code: normalizedError.code || 'DATASET_IMPORT_ERROR',
        message: normalizedError.message || 'Dataset import failed.',
        expectedRows: allRecords.length,
        actualCounts,
        batchAccounting: error?.importBatchAccounting || null,
        failedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        cleanup: { status: 'RUNNING' }
      };
      try {
        failedDataset = await updateDatasetImportState(failedDataset, failedImport);
        await deleteDatasetRows(datasetId);
        failureCleanup = { status: 'COMPLETED', rawAndNormalizedRowsRemoved: true };
      } catch (cleanupError) {
        failureCleanup = { status: 'FAILED', code: normalizeDatabaseError(cleanupError).code, error: cleanupError.message || 'Could not remove partial rows from failed import.' };
        console.error(`[DATASET IMPORT] partial-row cleanup failed dataset=${datasetId} code=${failureCleanup.code}`);
      }
      try {
        failedDataset = await updateDatasetImportState(failedDataset, {
          ...failedDataset.detected_entities.import,
          cleanup: failureCleanup,
          updatedAt: new Date().toISOString()
        });
      } catch (stateError) {
        console.error(`[DATASET IMPORT] failure state persistence failed dataset=${datasetId} code=${normalizeDatabaseError(stateError).code}`);
      }
    } else if (datasetId && dataset) {
      failureCleanup = {
        status: 'SKIPPED_DATABASE_ERROR',
        code: normalizedError.code,
        reason: 'The database write outcome is uncertain, so no cleanup DELETE was attempted.'
      };
    }

    return res
      .status(normalizedError.status || 500)
      .json({
        success: false,

        error:
          normalizedError.message ||
          'Dataset import failed.',

        code:
          normalizedError.code ||
          'DATASET_IMPORT_ERROR',
        datasetId,
        cleanup: failureCleanup,
        summary: {
          totalRows: allRecords.length,
          validRows,
          errorRows,
          actualCounts,
          batchAccounting: error?.importBatchAccounting || null
        }
      });
  }
}


/*
 * ============================================================
 * DELETE DATASET
 * ============================================================
 */
async function deleteDataset(
  req,
  res
) {
  const {
    id
  } =
    req.body || {};

  if (!id) {
    return res
      .status(400)
      .json({
        success: false,
        error:
          'Missing dataset id'
      });
  }

  const datasetId = Number(id);
  if (!Number.isSafeInteger(datasetId) || datasetId <= 0) {
    return res.status(400).json({ success: false, error: 'Dataset id must be a positive integer.', code: 'INVALID_DATASET_ID' });
  }
  if (isProtectedDatasetId(datasetId)) {
    return res.status(409).json({ success: false, error: 'Dataset 9 is protected during this audit fix.', code: 'DATASET_PROTECTED' });
  }
  const { data: dataset, error: datasetReadError } = await supabase
    .from('datasets')
    .select('id,filename,total_rows,created_at,updated_at,storage_key,content_hash,original_size_bytes,import_status,analysis_status,detected_entities')
    .eq('id', datasetId)
    .maybeSingle();
  if (datasetReadError) throw datasetReadError;
  if (!dataset) return res.status(404).json({ success: false, error: `Dataset ${datasetId} was not found.`, code: 'DATASET_NOT_FOUND' });
  const stale = isImportStale(dataset.detected_entities?.import, dataset);
  const force = req.query?.force === 'true' || req.body?.force === true;
  if ((dataset.import_status === 'RUNNING' || dataset.analysis_status === 'RUNNING' || dataset.detected_entities?.import?.status === 'RUNNING' || dataset.detected_entities?.pipeline?.status === 'RUNNING') && !stale && !force) {
    return res.status(409).json({ success: false, error: `Dataset ${datasetId} is currently running and cannot be deleted.`, code: 'DATASET_RUNNING' });
  }
  if (!isCompletedAnalysis(dataset) && !stale && !force) {
    return res.status(409).json({ success: false, error: `Dataset ${datasetId} is not a completed analysis and cannot be deleted. Pass force=true to delete incomplete datasets.`, code: 'INCOMPLETE_ANALYSIS_PROTECTED' });
  }

  const storageCleanup = dataset.storage_key
    ? await prepareDatasetSourceObjectCleanup(supabase, dataset, null, verifyDatasetSourceObjectOwnership)
    : { proof: null, marker: null };
  const deletion = await deleteDatasetRows(datasetId);
  const sourceObject = dataset.storage_key
    ? await deleteSourceObject(dataset, storageCleanup.proof)
    : { deleted: false, reason: 'NO_STORAGE_KEY' };

  let deleteDatasetQuery = supabase
    .from('datasets')
    .delete()
    .eq('id', datasetId);
  deleteDatasetQuery = filterDatasetStateVersion(deleteDatasetQuery, dataset.updated_at);
  const { data: deleted, error: datasetDeleteError } = await deleteDatasetQuery.select('id').maybeSingle();

  if (datasetDeleteError) throw datasetDeleteError;
  if (!deleted) return res.status(409).json({ success: false, error: `Dataset ${datasetId} changed before deletion completed.`, code: 'DATASET_DELETE_CONFLICT' });
  await logAudit(req.user?.email, 'DELETE_DATASET', 'dataset', datasetId, {
    rowsDeletedByTable: deletion.deletedByTable,
    sourceObjectDeleted: sourceObject.deleted
  });

  return res
    .status(200)
    .json({
      success: true,
      ok: true,
      deleted: datasetId,
      rowsDeletedByTable: deletion.deletedByTable,
      sourceObjectDeleted: sourceObject.deleted
    });
}


/*
 * ============================================================
 * MAIN API HANDLER
 * ============================================================
 */
export default async function handler(
  req,
  res
) {
  setCors(res);

  /*
   * CORS preflight.
   */
  if (
    req.method === 'OPTIONS'
  ) {
    return res
      .status(204)
      .end();
  }

  /*
   * Authentication.
   */
  if (
    !(await requireAuth(
      req,
      res,
      { adminOnly: req.method === 'DELETE' }
    ))
  ) {
    return;
  }

  try {
    /*
     * GET
     */
    if (
      req.method === 'GET'
    ) {
      return await getDatasets(
        req,
        res
      );
    }

    /*
     * POST
     */
    if (
      req.method === 'POST'
    ) {
      const action = req.body?.action;
      if (action === 'PREPARE_UPLOAD') return await prepareSourceUpload(req, res);
      if (action === 'START_IMPORT') return await startChunkedImport(req, res);
      if (action === 'APPEND_IMPORT_BATCH') return await appendImportBatch(req, res);
      if (action === 'COMPLETE_IMPORT') return await completeChunkedImport(req, res);
      return await importDataset(
        req,
        res
      );
    }

    /*
     * DELETE
     */
    if (
      req.method === 'DELETE'
    ) {
      return await deleteDataset(
        req,
        res
      );
    }

    /*
     * Unsupported method.
     */
    return res
      .status(405)
      .json({
        success: false,
        error:
          'Method not allowed'
      });

  } catch (error) {
    const normalized = normalizeDatabaseError(error, 'Dataset operation failed.');
    console.error(`[DATASET API] operation failed method=${req.method} code=${normalized.code}`);
    return apiErrorResponse(res, normalized, 'DATASET_API_ERROR');
  }
}

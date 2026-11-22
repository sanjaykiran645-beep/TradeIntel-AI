import React, { useRef, useState, useEffect } from 'react';
import apiFetch from '../lib/api';
import { parseTradeFile } from '../lib/trade-file-parser';
import Topbar from '../components/Topbar';
import { Pill, EmptyState, LoadingState, ErrorBanner, StatCard, formatDate } from '../components/UI';
import { useOutletContext } from 'react-router-dom';
import {
  Upload, FileSpreadsheet, CheckCircle2, AlertTriangle, RefreshCw,
  Clock, Database, Layers, CheckCircle, ArrowRight, ShieldCheck, Play,
  ChevronLeft, ChevronRight, Sparkles, Building2, Package
} from 'lucide-react';
import { describeApiError, formatElapsed } from '../lib/api-data';

export default function ImportData() {
  const { mobileSidebarOpen, setMobileSidebarOpen } = useOutletContext() || {};
  const fileRef = useRef(null);

  const [fileName, setFileName] = useState('');
  const [fileSizeBytes, setFileSizeBytes] = useState(0);
  const [uploadHash, setUploadHash] = useState('');
  const [rows, setRows] = useState([]);
  const [columns, setColumns] = useState([]);
  const [sourceFile, setSourceFile] = useState(null);
  const [loading, setLoading] = useState(false);
  const [stage, setStage] = useState('IDLE'); // IDLE | PARSING | PREPARING | UPLOADING | PERSISTING | COMPLETING | ANALYZING | COMPLETED | PAUSED | FAILED
  const [processedRows, setProcessedRows] = useState(0);
  const [totalRows, setTotalRows] = useState(0);
  const [datasetId, setDatasetId] = useState(null);
  const [summary, setSummary] = useState(null);
  const [parseMetrics, setParseMetrics] = useState(null);
  const [previewPage, setPreviewPage] = useState(1);
  const PREVIEW_PAGE_SIZE = 15;
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [elapsedMs, setElapsedMs] = useState(0);
  const [startTime, setStartTime] = useState(null);

  useEffect(() => {
    let timer;
    if (startTime && loading) {
      timer = setInterval(() => {
        setElapsedMs(Date.now() - startTime);
      }, 500);
    }
    return () => clearInterval(timer);
  }, [startTime, loading]);

  const MAX_FILE_SIZE_BYTES = 100 * 1024 * 1024; // 100 MB limit

  async function parseFile(file) {
    if (!file) return;
    if (file.size > MAX_FILE_SIZE_BYTES) {
      const sizeMb = (file.size / (1024 * 1024)).toFixed(1);
      setError(`File "${file.name}" (${sizeMb} MB) exceeds the maximum allowed limit of 100 MB. Please select a dataset under 100 MB.`);
      setStage('IDLE');
      return;
    }

    setLoading(true);
    setStage('PARSING');
    setError('');
    setMessage('');
    setSummary(null);
    setRows([]);
    setColumns([]);
    setUploadHash('');
    setParseMetrics(null);
    setPreviewPage(1);
    setSourceFile(file);
    setFileName(file.name);
    setFileSizeBytes(file.size);
    setProcessedRows(0);
    setTotalRows(0);
    setStartTime(Date.now());

    try {
      const sourceBytes = await file.arrayBuffer();
      const parsed = parseTradeFile({
        fileName: file.name,
        fileSize: file.size,
        sourceBytes
      });
      const allRows = parsed.rows;
      const allColumns = parsed.columns;

      if (!globalThis.crypto?.subtle) {
        throw new Error('Secure SHA-256 hashing is unavailable in this browser context.');
      }
      const fileDigest = await globalThis.crypto.subtle.digest('SHA-256', sourceBytes);
      const fileHash = Array.from(new Uint8Array(fileDigest), value => value.toString(16).padStart(2, '0')).join('');

      setRows(allRows);
      setColumns(allColumns);
      setTotalRows(allRows.length);
      setParseMetrics(parsed);
      setUploadHash(fileHash);
      setStage('IDLE');
      const sheetMsg = parsed.sheetCount > 1 ? ` across ${parsed.sheetCount} worksheets` : '';
      setMessage(`Validated "${file.name}"${sheetMsg}: ${allRows.length.toLocaleString()} trade records parsed (${parsed.validRows.toLocaleString()} valid, ${parsed.duplicateRows.toLocaleString()} duplicate, ${parsed.errorRows.toLocaleString()} malformed) ready to persist.`);
    } catch (err) {
      console.error('Import file parsing error:', err);
      setStage('FAILED');
      setError(err?.message || 'Unable to parse the selected file.');
    } finally {
      setLoading(false);
    }
  }

  async function importData() {
    if (!rows.length) {
      setError('Please select a data file first.');
      return;
    }

    setLoading(true);
    setError('');
    setMessage('');
    setSummary(null);
    setStartTime(Date.now());
    let currentDatasetId = datasetId;
    let nextRowIndex = 0;

    try {
      if (!uploadHash) throw new Error('The source file fingerprint is missing. Re-select the file before importing.');

      const postJson = async payload => {
        const response = await apiFetch('/api/datasets', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload)
        });
        const result = await response.json();
        if (result?.success === false) {
          const requestError = new Error(result.error || 'Import failed.');
          requestError.code = result.code;
          requestError.payload = result;
          throw requestError;
        }
        return result;
      };

      if (!sourceFile) throw new Error('The original source file is unavailable. Re-select the file before importing.');

      // 1. Prepare upload
      setStage('PREPARING');
      const contentType = sourceFile.type || 'application/octet-stream';
      const prepared = await postJson({
        action: 'PREPARE_UPLOAD',
        filename: fileName,
        contentType,
        sizeBytes: sourceFile.size,
        contentHash: uploadHash
      });

      if (prepared.alreadyImported) {
        setDatasetId(prepared.datasetId);
        setStage('COMPLETED');
        setMessage(`This exact file is already persisted as dataset ${prepared.datasetId}. All records are available in the workspace.`);
        return;
      }

      let storageKey = prepared.storageKey || null;
      let originalSizeBytes = Number(prepared.originalSizeBytes || sourceFile.size);

      // 2. Upload source object if required
      if (!prepared.resume && prepared.uploadRequired !== false) {
        setStage('UPLOADING');
        const uploadResponse = await fetch(prepared.uploadUrl, {
          method: 'PUT',
          headers: prepared.headers,
          body: sourceFile
        });
        if (!uploadResponse.ok) {
          throw Object.assign(new Error(`Private source-file storage upload failed with HTTP ${uploadResponse.status}.`), { code: 'OBJECT_STORAGE_UPLOAD_FAILED' });
        }
        storageKey = prepared.storageKey;
        originalSizeBytes = sourceFile.size;
      }

      // 3. Start chunked import
      setStage('PERSISTING');
      const startPayload = {
        action: 'START_IMPORT',
        filename: fileName,
        fileType: fileName.split('.').pop() || 'csv',
        expectedRows: rows.length,
        columns,
        uploadHash,
        storageKey,
        originalSizeBytes
      };
      if (stage === 'FAILED') {
        startPayload.restart = true;
      }
      const started = await postJson(startPayload);

      currentDatasetId = started.datasetId;
      setDatasetId(currentDatasetId);

      if (started.duplicateRequest) {
        setStage('COMPLETED');
        setMessage(started.message || `This file is already persisted as dataset ${currentDatasetId}.`);
        return;
      }

      nextRowIndex = Number(started.nextRowIndex || 0);
      setProcessedRows(nextRowIndex);

      // 4. Send chunks in bounded batches
      while (nextRowIndex < rows.length) {
        let chunkEnd = Math.min(rows.length, nextRowIndex + 1000);
        let chunkRows = rows.slice(nextRowIndex, chunkEnd);
        let chunkBody = JSON.stringify({
          action: 'APPEND_IMPORT_BATCH',
          datasetId: currentDatasetId,
          uploadHash,
          startRowIndex: nextRowIndex,
          rows: chunkRows
        });

        while (new TextEncoder().encode(chunkBody).byteLength > 2 * 1024 * 1024 && chunkRows.length > 1) {
          chunkEnd = nextRowIndex + Math.ceil(chunkRows.length / 2);
          chunkRows = rows.slice(nextRowIndex, chunkEnd);
          chunkBody = JSON.stringify({
            action: 'APPEND_IMPORT_BATCH',
            datasetId: currentDatasetId,
            uploadHash,
            startRowIndex: nextRowIndex,
            rows: chunkRows
          });
        }

        const response = await apiFetch('/api/datasets', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: chunkBody
        });
        const result = await response.json();
        if (result?.success === false) {
          const requestError = new Error(result.error || 'Import batch failed.');
          requestError.code = result.code;
          requestError.payload = result;
          throw requestError;
        }

        const persistedNext = Number(result.nextRowIndex);
        if (!Number.isSafeInteger(persistedNext) || persistedNext <= nextRowIndex) {
          throw new Error('The backend did not confirm forward progress for the current import batch.');
        }

        nextRowIndex = persistedNext;
        setProcessedRows(nextRowIndex);
      }

      // 5. Complete and verify import
      setStage('COMPLETING');
      const completionResult = await postJson({ action: 'COMPLETE_IMPORT', datasetId: currentDatasetId, uploadHash });

      setProcessedRows(rows.length);
      const sum = completionResult?.summary || {
        totalRows: rows.length,
        validRows: rows.length,
        duplicateRows: 0,
        errorRows: 0,
        rawRowsInserted: rows.length,
        normalizedRowsInserted: rows.length
      };

      // 6. Automatically run full-dataset analysis & scoring across all imported rows
      setStage('ANALYZING');
      try {
        const supervisorRes = await apiFetch('/api/supervisor', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            dataset_id: currentDatasetId,
            targetStage: 'SUPERVISOR',
            retry: true
          })
        });
        const supervisorResult = await supervisorRes.json();
        const pipelineStages = supervisorResult?.pipeline?.stages || supervisorResult?.stages || {};
        const entityStage = pipelineStages.ENTITY_AGGREGATION || {};
        const intelligenceStage = pipelineStages.INTELLIGENCE || {};
        const leadStage = pipelineStages.LEAD_QUALIFICATION || {};

        sum.companies = entityStage.companies ?? entityStage.items ?? 0;
        sum.products = entityStage.products ?? 0;
        sum.markets = entityStage.markets ?? 0;
        sum.scoredEntities = intelligenceStage.recordsProduced ?? intelligenceStage.recordsProcessed ?? 0;
        sum.qualifiedLeads = leadStage.recordsProduced ?? leadStage.items ?? 0;
        if (supervisorResult?.success === false || supervisorResult?.status === 'FAILED') {
          sum.analysisStatus = 'FAILED';
          sum.analysisError = supervisorResult?.error || 'Intelligence analysis encountered an issue.';
        } else {
          sum.analysisStatus = supervisorResult?.status || 'COMPLETED';
        }
      } catch (analysisErr) {
        console.warn('Post-import supervisor analysis trigger error:', analysisErr);
        sum.analysisStatus = 'REVIEW_REQUIRED';
        sum.analysisError = analysisErr?.message || 'Automatic post-import analysis could not be initiated.';
      }

      setStage('COMPLETED');
      setSummary(sum);
      if (sum.analysisStatus === 'FAILED' || sum.analysisStatus === 'REVIEW_REQUIRED') {
        setMessage(`Data persistence verified (${Number(rows.length).toLocaleString()} rows), but automated analysis requires attention: ${sum.analysisError || 'Review required'}.`);
      } else {
        setMessage(completionResult?.message || `Successfully imported, verified, and analyzed ${Number(rows.length).toLocaleString()} trade records into dataset ${currentDatasetId}.`);
      }
    } catch (err) {
      console.error('Import error:', err);
      const described = describeApiError(err);
      currentDatasetId = err?.payload?.datasetId || currentDatasetId;
      if (Number.isSafeInteger(Number(err?.payload?.nextRowIndex))) {
        nextRowIndex = Number(err.payload.nextRowIndex);
        setProcessedRows(nextRowIndex);
      }

      if (currentDatasetId && nextRowIndex < rows.length && nextRowIndex > 0) {
        setStage('PAUSED');
        setError(`${described.text} Dataset ${currentDatasetId} is persisted through row ${nextRowIndex.toLocaleString()} of ${rows.length.toLocaleString()}. You can safely click "Resume Import" to continue without duplicate entries.`);
      } else {
        setStage('FAILED');
        setError(described.text);
      }
    } finally {
      setLoading(false);
    }
  }

  function clearData() {
    setFileName('');
    setFileSizeBytes(0);
    setUploadHash('');
    setRows([]);
    setColumns([]);
    setSourceFile(null);
    setMessage('');
    setError('');
    setSummary(null);
    setParseMetrics(null);
    setPreviewPage(1);
    setDatasetId(null);
    setProcessedRows(0);
    setTotalRows(0);
    setStage('IDLE');
    setStartTime(null);
    setElapsedMs(0);

    if (fileRef.current) {
      fileRef.current.value = '';
    }
  }

  const progressPercent = totalRows > 0 ? Math.min(100, Math.round((processedRows / totalRows) * 100)) : 0;
  const recordsPerSec = elapsedMs > 1000 && processedRows > 0 ? Math.round((processedRows / (elapsedMs / 1000))) : null;

  return (
    <>
      <Topbar
        title="Import Trade Intelligence"
        subtitle="Upload and reconcile large-scale trade data (CSV, XLSX, XLS, JSON up to 100 MB) with strict idempotency and validation."
        mobileSidebarOpen={mobileSidebarOpen}
        setMobileSidebarOpen={setMobileSidebarOpen}
      />
      <div className="p-4 lg:p-8 space-y-6 max-w-7xl mx-auto">
        {error && <ErrorBanner error={error} onClose={() => setError('')} />}

        {message && (
          <div className="flex items-start gap-3 bg-emerald-500/10 border border-emerald-500/30 text-emerald-200 p-4 rounded-xl">
            <CheckCircle className="w-5 h-5 mt-0.5 flex-shrink-0 text-emerald-400" />
            <div className="flex-1 text-sm">{message}</div>
          </div>
        )}

        {/* File Control Panel */}
        <div className="bg-[#0e1424] border border-amber-500/10 rounded-2xl p-6">
          <input
            ref={fileRef}
            type="file"
            accept=".csv,.xlsx,.xls,.json"
            className="hidden"
            onChange={(event) => {
              const file = event.target.files?.[0];
              if (file) {
                if (file.size > MAX_FILE_SIZE_BYTES) {
                  const sizeMb = (file.size / (1024 * 1024)).toFixed(1);
                  setError(`File "${file.name}" (${sizeMb} MB) exceeds the maximum limit of 100 MB. Please select a file up to 100 MB.`);
                  event.target.value = '';
                  return;
                }
                parseFile(file);
              }
            }}
          />

          <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
            <div>
              <h3 className="text-amber-50 font-medium text-lg flex items-center gap-2">
                <FileSpreadsheet className="w-5 h-5 text-amber-400" />
                Select Trade Dataset
              </h3>
              <p className="text-amber-200/60 text-xs mt-1">
                Supports official trade registries, customs declarations, shipping bills, and consignment exports (up to 100 MB).
              </p>
            </div>

            <div className="flex flex-wrap items-center gap-3">
              <button
                type="button"
                onClick={() => fileRef.current?.click()}
                disabled={loading}
                className="px-4 py-2.5 bg-amber-500/10 hover:bg-amber-500/20 text-amber-300 border border-amber-500/30 rounded-xl text-sm font-medium flex items-center gap-2 transition-colors disabled:opacity-50"
              >
                <Upload className="w-4 h-4" />
                {loading && stage === 'PARSING' ? 'Validating File…' : fileName ? 'Change File' : 'Choose Data File'}
              </button>

              {rows.length > 0 && stage !== 'COMPLETED' && (
                <button
                  type="button"
                  onClick={importData}
                  disabled={loading}
                  className="px-5 py-2.5 bg-amber-500 hover:bg-amber-400 text-[#070b16] font-semibold rounded-xl text-sm flex items-center gap-2 shadow-lg shadow-amber-500/10 transition-colors disabled:opacity-50"
                >
                  {loading ? (
                    <>
                      <RefreshCw className="w-4 h-4 animate-spin" />
                      <span>{stage === 'PREPARING' ? 'Preparing…' : stage === 'UPLOADING' ? 'Uploading…' : stage === 'COMPLETING' ? 'Verifying…' : stage === 'ANALYZING' ? 'Analyzing…' : 'Persisting…'}</span>
                    </>
                  ) : stage === 'PAUSED' ? (
                    <>
                      <Play className="w-4 h-4" />
                      <span>Resume Import</span>
                    </>
                  ) : (
                    <>
                      <Database className="w-4 h-4" />
                      <span>Start Resumable Import</span>
                    </>
                  )}
                </button>
              )}

              {rows.length > 0 && (
                <button
                  type="button"
                  onClick={clearData}
                  disabled={loading}
                  className="px-4 py-2.5 bg-transparent hover:bg-amber-500/5 text-amber-200/60 hover:text-amber-200 border border-amber-500/15 rounded-xl text-sm transition-colors disabled:opacity-50"
                >
                  Clear
                </button>
              )}
            </div>
          </div>

          {/* Active File Metadata */}
          {fileName && (
            <div className="mt-6 pt-5 border-t border-amber-500/10 grid grid-cols-2 md:grid-cols-4 gap-4 text-xs">
              <div>
                <span className="text-amber-200/40 uppercase tracking-wider block text-[10px]">File Name</span>
                <span className="text-amber-100 font-medium truncate block mt-0.5">{fileName}</span>
              </div>
              <div>
                <span className="text-amber-200/40 uppercase tracking-wider block text-[10px]">Total Parsed Rows</span>
                <span className="text-amber-300 font-medium block mt-0.5">
                  {totalRows.toLocaleString()} rows
                  {parseMetrics?.sheetCount > 1 && ` (${parseMetrics.sheetCount} sheets)`}
                </span>
              </div>
              <div>
                <span className="text-amber-200/40 uppercase tracking-wider block text-[10px]">File Size</span>
                <span className="text-amber-100 block mt-0.5">{(fileSizeBytes / (1024 * 1024)).toFixed(2)} MB</span>
              </div>
              <div>
                <span className="text-amber-200/40 uppercase tracking-wider block text-[10px]">Identified Columns</span>
                <span className="text-amber-100 block mt-0.5">{columns.length} columns recognized</span>
              </div>
            </div>
          )}
        </div>

        {/* Progress & Live Execution Status */}
        {loading && stage !== 'PARSING' && (
          <div className="bg-[#0e1424] border border-amber-500/20 rounded-2xl p-6 space-y-4">
            <div className="flex items-center justify-between text-sm">
              <div className="flex items-center gap-2">
                <RefreshCw className="w-4 h-4 text-amber-400 animate-spin" />
                <span className="text-amber-100 font-medium">
                  {stage === 'PREPARING' && 'Checking dataset fingerprints & private storage…'}
                  {stage === 'UPLOADING' && 'Storing private source object…'}
                  {stage === 'PERSISTING' && `Persisting database batches: ${processedRows.toLocaleString()} / ${totalRows.toLocaleString()} rows`}
                  {stage === 'COMPLETING' && 'Reconciling row counts & database integrity…'}
                  {stage === 'ANALYZING' && 'Running complete dataset analytics: entity extraction, intelligence scoring & qualification…'}
                </span>
              </div>
              <div className="flex items-center gap-4 text-xs text-amber-200/70">
                {recordsPerSec && <span>{recordsPerSec.toLocaleString()} rows/sec</span>}
                <span className="flex items-center gap-1 font-mono">
                  <Clock className="w-3.5 h-3.5 text-amber-400/70" />
                  {formatElapsed(elapsedMs)}
                </span>
                <span className="text-amber-400 font-semibold">{stage === 'ANALYZING' ? '95%' : `${progressPercent}%`}</span>
              </div>
            </div>

            {/* Progress Bar */}
            <div className="w-full bg-[#070b16] rounded-full h-2 overflow-hidden border border-amber-500/10">
              <div
                className="bg-gradient-to-r from-amber-500 to-amber-300 h-2 rounded-full transition-all duration-300"
                style={{ width: stage === 'ANALYZING' ? '95%' : `${progressPercent}%` }}
              />
            </div>
          </div>
        )}

        {/* Completed Verification Summary Card */}
        {summary && stage === 'COMPLETED' && (
          <div className={`bg-[#0e1424] border rounded-2xl p-6 space-y-5 ${summary.analysisStatus === 'COMPLETED' ? 'border-emerald-500/30' : 'border-amber-500/30'}`}>
            <div className="flex items-center justify-between border-b border-amber-500/10 pb-4">
              <div className="flex items-center gap-2">
                {summary.analysisStatus === 'COMPLETED' ? (
                  <>
                    <CheckCircle2 className="w-5 h-5 text-emerald-400" />
                    <h4 className="text-amber-50 font-medium">Full Dataset Import & Analytics Reconciliation</h4>
                  </>
                ) : (
                  <>
                    <AlertTriangle className="w-5 h-5 text-amber-400" />
                    <h4 className="text-amber-50 font-medium">Dataset Persisted — Analysis Requires Attention</h4>
                  </>
                )}
              </div>
              {summary.analysisStatus === 'COMPLETED' ? (
                <Pill label="100% PERSISTED & ANALYZED" color="emerald" />
              ) : (
                <Pill label={summary.analysisStatus === 'FAILED' ? 'ANALYSIS FAILED' : 'ANALYSIS PENDING REVIEW'} color="amber" />
              )}
            </div>

            {summary.analysisError && (
              <div className="bg-amber-500/10 border border-amber-500/30 rounded-xl p-3 text-xs text-amber-200 flex items-start gap-2">
                <AlertTriangle className="w-4 h-4 text-amber-400 shrink-0 mt-0.5" />
                <div>
                  <strong>Analysis Notice:</strong> {summary.analysisError} All source records were safely persisted. You can trigger scoring at any time from Dashboard or Research.
                </div>
              </div>
            )}

            {/* Row 1: Source Records Reconciliation */}
            <div className="space-y-2">
              <div className="text-[11px] font-mono text-amber-300/70 uppercase tracking-wider">Source Data Persistence</div>
              <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                <div className="bg-[#070b16] p-4 rounded-xl border border-amber-500/10">
                  <div className="text-[10px] text-amber-200/50 uppercase">Total Source Rows</div>
                  <div className="text-2xl font-light text-white mt-1">{summary.totalRows.toLocaleString()}</div>
                  <div className="text-[11px] text-emerald-400/80 mt-1">Confirmed in database</div>
                </div>
                <div className="bg-[#070b16] p-4 rounded-xl border border-amber-500/10">
                  <div className="text-[10px] text-amber-200/50 uppercase">Valid Normalized Records</div>
                  <div className="text-2xl font-light text-emerald-300 mt-1">{summary.validRows.toLocaleString()}</div>
                  <div className="text-[11px] text-amber-200/50 mt-1">Ready for intelligence scoring</div>
                </div>
                <div className="bg-[#070b16] p-4 rounded-xl border border-amber-500/10">
                  <div className="text-[10px] text-amber-200/50 uppercase">Duplicate Rows (Deduped)</div>
                  <div className="text-2xl font-light text-amber-300 mt-1">{summary.duplicateRows.toLocaleString()}</div>
                  <div className="text-[11px] text-amber-200/50 mt-1">Idempotently referenced</div>
                </div>
                <div className="bg-[#070b16] p-4 rounded-xl border border-amber-500/10">
                  <div className="text-[10px] text-amber-200/50 uppercase">Malformed / Error Rows</div>
                  <div className="text-2xl font-light text-rose-300 mt-1">{summary.errorRows.toLocaleString()}</div>
                  <div className="text-[11px] text-amber-200/50 mt-1">Safely segregated</div>
                </div>
              </div>
            </div>

            {/* Row 2: Derived Intelligence & Analytics */}
            <div className="space-y-2 pt-2 border-t border-amber-500/10">
              <div className="text-[11px] font-mono text-amber-300/70 uppercase tracking-wider">Derived Analytics & Scoring</div>
              <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                <div className="bg-[#070b16] p-4 rounded-xl border border-amber-500/10">
                  <div className="text-[10px] text-amber-200/50 uppercase flex items-center gap-1.5">
                    <Building2 className="w-3 h-3 text-amber-400" /> Companies Extracted
                  </div>
                  <div className="text-2xl font-light text-amber-200 mt-1">
                    {summary.companies !== null && summary.companies !== undefined ? summary.companies.toLocaleString() : '—'}
                  </div>
                  <div className="text-[11px] text-amber-200/40 mt-1">Aggregated entities</div>
                </div>
                <div className="bg-[#070b16] p-4 rounded-xl border border-amber-500/10">
                  <div className="text-[10px] text-amber-200/50 uppercase flex items-center gap-1.5">
                    <Package className="w-3 h-3 text-amber-400" /> Products Identified
                  </div>
                  <div className="text-2xl font-light text-amber-200 mt-1">
                    {summary.products !== null && summary.products !== undefined ? summary.products.toLocaleString() : '—'}
                  </div>
                  <div className="text-[11px] text-amber-200/40 mt-1">Cataloged commodities</div>
                </div>
                <div className="bg-[#070b16] p-4 rounded-xl border border-amber-500/10">
                  <div className="text-[10px] text-amber-200/50 uppercase flex items-center gap-1.5">
                    <Sparkles className="w-3 h-3 text-amber-400" /> Scored Entities
                  </div>
                  <div className="text-2xl font-light text-amber-300 mt-1">
                    {summary.scoredEntities !== null && summary.scoredEntities !== undefined ? summary.scoredEntities.toLocaleString() : '—'}
                  </div>
                  <div className="text-[11px] text-amber-200/40 mt-1">8-factor evaluated</div>
                </div>
                <div className="bg-[#070b16] p-4 rounded-xl border border-amber-500/10">
                  <div className="text-[10px] text-amber-200/50 uppercase flex items-center gap-1.5">
                    <ShieldCheck className="w-3 h-3 text-emerald-400" /> Qualified Leads
                  </div>
                  <div className="text-2xl font-light text-emerald-300 mt-1">
                    {summary.qualifiedLeads !== null && summary.qualifiedLeads !== undefined ? summary.qualifiedLeads.toLocaleString() : '—'}
                  </div>
                  <div className="text-[11px] text-emerald-400/80 mt-1">Score ≥75 & Txns ≥10</div>
                </div>
              </div>
            </div>
          </div>
        )}

        {/* Data Preview */}
        {rows.length > 0 && (
          <div className="bg-[#0e1424] border border-amber-500/10 rounded-2xl overflow-hidden">
            <div className="p-5 border-b border-amber-500/10 flex items-center justify-between">
              <div>
                <h3 className="text-amber-50 font-medium text-sm">Source Data Preview</h3>
                <p className="text-amber-200/50 text-xs mt-0.5">
                  Displaying records {((previewPage - 1) * PREVIEW_PAGE_SIZE) + 1}–{Math.min(rows.length, previewPage * PREVIEW_PAGE_SIZE).toLocaleString()} of {rows.length.toLocaleString()} total rows loaded in memory.
                </p>
              </div>
              <div className="flex items-center gap-3">
                <span className="text-xs text-amber-300/80 font-mono">
                  Page {previewPage} of {Math.max(1, Math.ceil(rows.length / PREVIEW_PAGE_SIZE)).toLocaleString()}
                </span>
                <div className="flex items-center gap-1">
                  <button
                    type="button"
                    disabled={previewPage <= 1}
                    onClick={() => setPreviewPage(p => Math.max(1, p - 1))}
                    className="p-1 rounded bg-[#070b16] border border-amber-500/20 text-amber-300 disabled:opacity-30 hover:bg-amber-500/10 transition-colors"
                    title="Previous Page"
                  >
                    <ChevronLeft className="w-4 h-4" />
                  </button>
                  <button
                    type="button"
                    disabled={previewPage >= Math.ceil(rows.length / PREVIEW_PAGE_SIZE)}
                    onClick={() => setPreviewPage(p => Math.min(Math.ceil(rows.length / PREVIEW_PAGE_SIZE), p + 1))}
                    className="p-1 rounded bg-[#070b16] border border-amber-500/20 text-amber-300 disabled:opacity-30 hover:bg-amber-500/10 transition-colors"
                    title="Next Page"
                  >
                    <ChevronRight className="w-4 h-4" />
                  </button>
                </div>
              </div>
            </div>

            <div className="overflow-x-auto max-h-96">
              <table className="w-full text-xs text-left">
                <thead className="bg-[#070b16] text-amber-200/60 uppercase text-[10px] tracking-wider sticky top-0 border-b border-amber-500/10">
                  <tr>
                    <th className="px-4 py-3">#</th>
                    {columns.map(col => (
                      <th key={col} className="px-4 py-3 whitespace-nowrap">{col}</th>
                    ))}
                  </tr>
                </thead>
                <tbody className="divide-y divide-amber-500/5 text-amber-100">
                  {rows.slice((previewPage - 1) * PREVIEW_PAGE_SIZE, previewPage * PREVIEW_PAGE_SIZE).map((row, localIdx) => {
                    const idx = (previewPage - 1) * PREVIEW_PAGE_SIZE + localIdx;
                    return (
                      <tr key={idx} className="hover:bg-amber-500/5 transition-colors">
                        <td className="px-4 py-2.5 font-mono text-amber-200/40">{idx + 1}</td>
                        {columns.map(col => (
                          <td key={`${idx}-${col}`} className="px-4 py-2.5 whitespace-nowrap max-w-xs truncate">
                            {String(row[col] ?? '')}
                          </td>
                        ))}
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {/* Empty State */}
        {!rows.length && !loading && (
          <EmptyState
            icon={Database}
            title="NO TRADE DATASET SELECTED"
            description="Choose a CSV, XLSX, XLS or JSON export file to parse, validate, and persist trade records."
            action={
              <button
                type="button"
                onClick={() => fileRef.current?.click()}
                className="mt-4 px-4 py-2 bg-amber-500 hover:bg-amber-400 text-[#070b16] font-semibold text-xs rounded-xl shadow-lg transition-colors"
              >
                Browse Files
              </button>
            }
          />
        )}
      </div>
    </>
  );
}

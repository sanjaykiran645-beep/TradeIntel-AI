export function timestampEpochMillis(value) {
  if (value instanceof Date) return Number.isFinite(value.getTime()) ? value.getTime() : null;
  if (typeof value !== 'string') return null;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : null;
}

function markerForDiagnostic(value) {
  return Number.isSafeInteger(value) ? value : null;
}

export function matchTimestampAttempt(attempts, requestMarker) {
  const matches = attempts.filter(attempt => attempt.testRequest === requestMarker);
  return matches.length === 1 ? matches[0] : null;
}

export function createTimestampPairDiagnostic({ persistedRequest, persistedUpdatedAt, timestampAttempt }) {
  const persistedMillis = timestampEpochMillis(persistedUpdatedAt);
  const attemptedMillis = timestampEpochMillis(timestampAttempt?.updatedAt);
  const toIso = value => value === null ? null : new Date(value).toISOString();

  return {
    persistedRequestMarker: markerForDiagnostic(persistedRequest),
    attemptedRequestMarker: markerForDiagnostic(timestampAttempt?.testRequest),
    persistedUpdatedAt: toIso(persistedMillis),
    attemptedUpdatedAt: toIso(attemptedMillis),
    differenceMs: persistedMillis === null || attemptedMillis === null
      ? null
      : persistedMillis - attemptedMillis
  };
}

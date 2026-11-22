export function parseOptionalTradeNumber(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;

  const text = String(value).trim();
  if (!text) return null;
  const cleaned = text.replace(/,/g, '').replace(/[^\d.+-]/g, '');
  if (!/\d/.test(cleaned)) return null;
  const parsed = Number(cleaned);
  return Number.isFinite(parsed) ? parsed : null;
}

export function completeObservedTotal({ rowCount, observedCount, total, classifications = null, requiredClassification = null }) {
  const expected = Number(rowCount);
  const observed = Number(observedCount);
  const sum = Number(total);
  if (!Number.isSafeInteger(expected) || expected <= 0 || observed !== expected || !Number.isFinite(sum)) return null;

  if (classifications !== null) {
    const values = classifications instanceof Set ? [...classifications] : classifications;
    if (!Array.isArray(values) || values.length !== 1) return null;
    if (requiredClassification !== null && values[0] !== requiredClassification) return null;
  } else if (requiredClassification !== null) {
    return null;
  }

  return sum;
}

export function commercialRelevanceFactor(transactionCount, totalValue) {
  const transactions = Number(transactionCount);
  const amount = totalValue === null || totalValue === undefined || totalValue === ''
    ? null
    : Number(totalValue);
  const evidence = {
    sourceTransactionCount: Number.isFinite(transactions) ? transactions : null,
    transactionValue: Number.isFinite(amount) ? amount : null,
    currency: Number.isFinite(amount) ? 'INR' : null
  };

  if (!Number.isFinite(transactions) || transactions <= 0 || !Number.isFinite(amount)) {
    return {
      value: null,
      status: 'UNAVAILABLE',
      reason: 'Complete INR-denominated trade values are unavailable.',
      evidence
    };
  }

  let value = 0;
  if (amount > 100000) value = 15;
  else if (amount > 50000) value = 13;
  else if (amount > 15000) value = 10;
  else if (amount > 1000) value = 7;
  return { value, status: 'AVAILABLE', reason: null, evidence };
}

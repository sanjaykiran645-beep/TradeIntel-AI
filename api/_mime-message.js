function splitHeadersAndBody(source) {
  const text = Buffer.isBuffer(source) ? source.toString('utf8') : String(source || '');
  const boundary = text.search(/\r?\n\r?\n/);
  if (boundary < 0) return { headers: {}, body: text };
  const headerText = text.slice(0, boundary).replace(/\r?\n[ \t]+/g, ' ');
  const body = text.slice(boundary).replace(/^\r?\n\r?\n/, '');
  const headers = {};
  for (const line of headerText.split(/\r?\n/)) {
    const separator = line.indexOf(':');
    if (separator <= 0) continue;
    const name = line.slice(0, separator).trim().toLowerCase();
    const value = line.slice(separator + 1).trim();
    headers[name] = headers[name] ? `${headers[name]}, ${value}` : value;
  }
  return { headers, body };
}

function headerParameter(value, name) {
  const match = String(value || '').match(new RegExp(`(?:^|;)\\s*${name}\\s*=\\s*(?:"([^"]+)"|([^;]+))`, 'i'));
  return (match?.[1] || match?.[2] || '').trim();
}

function decodeBody(body, encoding) {
  const normalized = String(encoding || '').toLowerCase();
  if (normalized === 'base64') {
    try { return Buffer.from(body.replace(/\s/g, ''), 'base64').toString('utf8'); } catch { return ''; }
  }
  if (normalized === 'quoted-printable') {
    return body
      .replace(/=\r?\n/g, '')
      .replace(/=([0-9a-f]{2})/gi, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
  }
  return body;
}

function parseMimePart(source) {
  const { headers, body } = splitHeadersAndBody(source);
  const contentType = headers['content-type'] || 'text/plain';
  const mediaType = contentType.split(';')[0].trim().toLowerCase();
  if (mediaType.startsWith('multipart/')) {
    const boundary = headerParameter(contentType, 'boundary');
    if (!boundary) return '';
    const parts = body.split(new RegExp(`(?:^|\\r?\\n)--${boundary.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\$&')}(?:--)?\\r?\\n`));
    let htmlFallback = '';
    for (const part of parts) {
      if (!part.trim() || part.trim() === '--') continue;
      const parsed = parseMimePart(part.replace(/\r?\n--$/, ''));
      if (parsed.type === 'text/plain' && parsed.body.trim()) return parsed;
      if (parsed.type === 'text/html' && !htmlFallback) htmlFallback = parsed.body;
    }
    return { type: 'text/html', body: htmlFallback };
  }

  if (!mediaType.startsWith('text/')) return { type: mediaType, body: '' };
  return { type: mediaType, body: decodeBody(body, headers['content-transfer-encoding']) };
}

function htmlToText(value) {
  return String(value || '')
    .replace(/<\s*br\s*\/?>/gi, '\n')
    .replace(/<\/(?:p|div|tr|li)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&#39;/gi, "'")
    .replace(/&quot;/gi, '"')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function decodeHeader(value) {
  return String(value || '').replace(/=\?([^?]+)\?([bq])\?([^?]*)\?=/gi, (whole, charset, mode, content) => {
    try {
      const bytes = mode.toLowerCase() === 'b'
        ? Buffer.from(content, 'base64')
        : Buffer.from(content.replace(/_/g, ' ').replace(/=([0-9a-f]{2})/gi, (_, hex) => String.fromCharCode(parseInt(hex, 16))), 'binary');
      return new TextDecoder(charset, { fatal: false }).decode(bytes);
    } catch {
      return whole;
    }
  });
}

export function parseMimeMessage(source) {
  const { headers } = splitHeadersAndBody(source);
  const parsedBody = parseMimePart(source);
  const bodyText = parsedBody.type === 'text/html' ? htmlToText(parsedBody.body) : parsedBody.body.trim();
  return {
    messageId: (headers['message-id'] || '').trim(),
    inReplyTo: (headers['in-reply-to'] || '').trim(),
    references: (headers.references || '').trim(),
    subject: decodeHeader(headers.subject || ''),
    from: decodeHeader(headers.from || ''),
    bodyText
  };
}

export function normalizeReplySubject(subject) {
  return String(subject || '').replace(/^(?:(?:re|fw|fwd)\s*:\s*)+/i, '').trim().toLowerCase();
}

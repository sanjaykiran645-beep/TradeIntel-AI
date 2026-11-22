import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

const ENVELOPE_KIND = 'hostinger_config_encrypted';

function encryptionKey(value = process.env.HOSTINGER_CONFIG_ENCRYPTION_KEY) {
  const text = String(value || '').trim();
  if (!text) {
    throw Object.assign(new Error('HOSTINGER_CONFIG_ENCRYPTION_KEY must be configured before saving Hostinger credentials.'), {
      code: 'HOSTINGER_ENCRYPTION_KEY_NOT_CONFIGURED',
      status: 503
    });
  }
  const key = /^[a-f0-9]{64}$/i.test(text)
    ? Buffer.from(text, 'hex')
    : Buffer.from(text, 'base64');
  if (key.length !== 32) {
    throw Object.assign(new Error('HOSTINGER_CONFIG_ENCRYPTION_KEY must be 32 bytes encoded as base64 or 64-character hex.'), {
      code: 'HOSTINGER_ENCRYPTION_KEY_INVALID',
      status: 503
    });
  }
  return key;
}

export function encryptHostingerConfig(value, keyValue) {
  const key = encryptionKey(keyValue);
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([
    cipher.update(JSON.stringify(value), 'utf8'),
    cipher.final()
  ]);
  return {
    kind: ENVELOPE_KIND,
    version: 1,
    algorithm: 'aes-256-gcm',
    iv: iv.toString('base64'),
    authTag: cipher.getAuthTag().toString('base64'),
    ciphertext: ciphertext.toString('base64')
  };
}

export function decryptHostingerConfig(value, keyValue) {
  if (!value || typeof value !== 'object' || value.kind !== ENVELOPE_KIND) {
    return { value: value && typeof value === 'object' ? value : null, storage: value ? 'LEGACY_UNENCRYPTED' : 'NOT_CONFIGURED' };
  }
  if (value.version !== 1 || value.algorithm !== 'aes-256-gcm') {
    throw Object.assign(new Error('Stored Hostinger configuration uses an unsupported encryption format.'), {
      code: 'HOSTINGER_ENCRYPTION_FORMAT_UNSUPPORTED',
      status: 503
    });
  }
  try {
    const decipher = createDecipheriv('aes-256-gcm', encryptionKey(keyValue), Buffer.from(value.iv, 'base64'));
    decipher.setAuthTag(Buffer.from(value.authTag, 'base64'));
    const plaintext = Buffer.concat([
      decipher.update(Buffer.from(value.ciphertext, 'base64')),
      decipher.final()
    ]).toString('utf8');
    return { value: JSON.parse(plaintext), storage: 'ENCRYPTED' };
  } catch (error) {
    if (error.code?.startsWith('HOSTINGER_')) throw error;
    throw Object.assign(new Error('Stored Hostinger configuration could not be decrypted. Check HOSTINGER_CONFIG_ENCRYPTION_KEY.'), {
      code: 'HOSTINGER_ENCRYPTION_KEY_INVALID',
      status: 503
    });
  }
}

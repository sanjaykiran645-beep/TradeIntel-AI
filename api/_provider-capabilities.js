import { getHostingerConfig } from './_utils.js';
import { dbConfigured } from './_db-client.js';
import { authConfigured } from './_auth-client.js';
import { objectStorageConfigured } from './_object-storage.js';
import { getContactDiscoveryConfiguration } from './_contact-discovery.js';

export async function getProviderCapabilities(existingHostingerConfig = null) {
  const hostinger = existingHostingerConfig || await getHostingerConfig();
  const contactDiscovery = getContactDiscoveryConfiguration();
  return {
    database: {
      provider: 'Managed PostgreSQL',
      configured: dbConfigured,
      reason: dbConfigured ? null : 'DATABASE_URL is not configured.'
    },
    authentication: {
      provider: 'Supabase Auth',
      configured: authConfigured,
      reason: authConfigured ? null : 'Supabase Auth URL or anon key is not configured.'
    },
    sourceFileStorage: {
      provider: 'S3-compatible private object storage',
      implemented: true,
      configured: objectStorageConfigured,
      reason: objectStorageConfigured
        ? null
        : 'Original workbook storage is not configured; parsed raw and normalized rows are stored in PostgreSQL.'
    },
    research: {
      provider: process.env.RESEARCH_PROVIDER_NAME || null,
      implemented: !!process.env.RESEARCH_API_KEY,
      configured: !!process.env.RESEARCH_API_KEY,
      reason: process.env.RESEARCH_API_KEY ? null : 'No web research provider integration or provider credentials are configured.'
    },
    contactDiscovery,
    gmailOAuth: hostinger.gmailOAuth || null,
    smtp: {
      provider: hostinger.provider === 'GMAIL_OAUTH' ? 'Gmail API (OAuth 2.0)' : 'Hostinger SMTP via Nodemailer',
      implemented: true,
      configured: hostinger.smtpConfigured,
      reason: hostinger.smtpReason,
      source: hostinger.source
    },
    imap: {
      provider: hostinger.provider === 'GMAIL_OAUTH' ? 'Gmail API (OAuth 2.0)' : 'Hostinger IMAP via ImapFlow',
      implemented: true,
      configured: hostinger.imapConfigured,
      reason: hostinger.imapReason,
      credentialSource: hostinger.imap?.credentialSource || null,
      source: hostinger.source
    }
  };
}

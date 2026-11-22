// Canonical migration order shared by the runner and reply-sender readiness checks.
export const migrationPlan = Object.freeze([
  { version: '001_initial_schema', file: '001_initial_schema.sql' },
  { version: '002_nullable_unavailable_potential_factors', file: '002_nullable_unavailable_potential_factors.sql' },
  { version: '002_rename_web_research_column', file: '002_rename_web_research_column.sql' },
  { version: '003_add_web_research_uniqueness', file: '003_add_web_research_uniqueness.sql' },
  { version: '004_contact_discovery_provenance', file: '004_contact_discovery_provenance.sql' },
  { version: '005_preserve_unavailable_evidence', file: '005_preserve_unavailable_evidence.sql' },
  { version: '006_web_research_result_contract', file: '006_web_research_result_contract.sql' },
  { version: '007_response_draft_send_state', file: '007_response_draft_send_state.sql' },
  { version: '008_reply_sender_boundary', file: '008_reply_sender_boundary.sql' },
  { version: '009_reply_sender_safety_hardening', file: '009_reply_sender_safety_hardening.sql' }
]);

export const REPLY_SENDER_MIGRATION_CHECKPOINTS = Object.freeze([
  '007_response_draft_send_state',
  '008_reply_sender_boundary',
  '009_reply_sender_safety_hardening'
]);

export function migrationPlanThrough(version) {
  if (!REPLY_SENDER_MIGRATION_CHECKPOINTS.includes(version)) {
    throw new Error('A reply-sender migration checkpoint must be 007, 008, or 009.');
  }
  const index = migrationPlan.findIndex(migration => migration.version === version);
  if (index < 0) throw new Error('The requested reply-sender checkpoint is missing from the migration plan.');
  return migrationPlan.slice(0, index + 1);
}

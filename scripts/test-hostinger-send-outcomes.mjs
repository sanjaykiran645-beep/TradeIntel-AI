import assert from 'node:assert/strict';
import { classifyHostingerSendFailure, hostingerSentDisposition } from '../api/_routes/hostinger.js';

const recipient = 'buyer@example.invalid';

const definitivePreSubmission = classifyHostingerSendFailure({
  code: 'ECONNREFUSED',
  command: 'CONN',
  message: 'private transport details must not be persisted'
}, recipient);
assert.equal(definitivePreSubmission.outcome, 'FAILED');
assert.equal(definitivePreSubmission.recordStatus, 'FAILED');
assert.equal(definitivePreSubmission.outcomeEvidence, 'SMTP_PRE_SUBMISSION_FAILURE');
assert.equal(definitivePreSubmission.sendError, 'SMTP_NOT_SUBMITTED_ECONNREFUSED');

const explicitSmtpRejection = classifyHostingerSendFailure({
  responseCode: 550,
  command: 'RCPT TO',
  response: '550 recipient rejected'
}, recipient);
assert.equal(explicitSmtpRejection.outcome, 'FAILED');
assert.equal(explicitSmtpRejection.recordStatus, 'FAILED');
assert.equal(explicitSmtpRejection.smtpCode, 550);

for (const ambiguousError of [
  { code: 'ETIMEDOUT', command: 'DATA', message: 'timeout after submission may have started' },
  { code: 'ECONNRESET', command: 'DATA', message: 'connection lost' },
  { code: 'EUNKNOWN', command: 'UNKNOWN', message: 'transport outcome unknown' }
]) {
  const result = classifyHostingerSendFailure(ambiguousError, recipient);
  assert.equal(result.outcome, 'UNKNOWN');
  assert.equal(result.recordStatus, 'UNKNOWN');
  assert.equal(result.outcomeEvidence, 'SMTP_ACCEPTANCE_UNCERTAIN');
  assert.match(result.sendError, /^SMTP_OUTCOME_UNKNOWN/);
  assert.equal(result.sendError.includes(ambiguousError.message), false);
}

const fullyPersisted = hostingerSentDisposition();
assert.equal(fullyPersisted.status, 'SENT');
assert.equal(fullyPersisted.send_state, 'SENT');
assert.deepEqual(fullyPersisted.warnings, []);

const acceptedWithAncillaryFailures = hostingerSentDisposition({
  followUpPersisted: false,
  auditPersisted: false,
  pipelinePersisted: false
});
assert.equal(acceptedWithAncillaryFailures.status, 'SENT_WITH_WARNINGS');
assert.equal(acceptedWithAncillaryFailures.send_state, 'SENT');
assert.equal(acceptedWithAncillaryFailures.success, true);
assert.equal(acceptedWithAncillaryFailures.warnings.length, 3);
assert.ok(acceptedWithAncillaryFailures.warnings.every(warning => !/password|credential|smtp response|recipient/i.test(warning)));

console.log('Offline Hostinger SMTP outcome classification and post-acceptance persistence disposition passed.');

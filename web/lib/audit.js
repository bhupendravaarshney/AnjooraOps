import { uuid } from '@/lib/ids';
import { correlationId, hashPrivateValue, requestIp } from '@/lib/http';

export async function writeAudit(db, {
  request,
  staffId = null,
  entityType,
  entityId = null,
  action,
  priorState = null,
  resultingState = null,
  outcome = 'SUCCESS',
  payload = {},
  correlation = null,
}) {
  const requestCorrelation = correlation || (request ? correlationId(request) : uuid());
  const ipHash = request ? hashPrivateValue(requestIp(request)) : null;
  await db.query(`
    INSERT INTO audit_events (
      id, staff_user_id, entity_type, entity_id, action, payload,
      correlation_id, prior_state, resulting_state, outcome, ip_hash
    ) VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,$8,$9,$10,$11)
  `, [
    uuid(), staffId, entityType, entityId, action,
    JSON.stringify(payload), requestCorrelation, priorState, resultingState, outcome, ipHash,
  ]);
  return requestCorrelation;
}


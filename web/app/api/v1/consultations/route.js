import { query } from '@/lib/db';
import { ConsultationInputError, normalizeConsultationPayload } from '@/lib/consultation-input';
import { submitConsultation } from '@/lib/consultation-service';
import { enforceRateLimit } from '@/lib/rate-limit';
import {
  HttpError,
  correlationId,
  errorResponse,
  hashPrivateValue,
  readJsonBody,
  requestIp,
  secureEqual,
} from '@/lib/http';
import { writeAudit } from '@/lib/audit';

export async function POST(request) {
  const correlation = correlationId(request);
  let authenticated = false;
  try {
    const expectedSecret = process.env.ANJOORA_INTEGRATION_SECRET;
    if (!expectedSecret) throw new HttpError(503, 'Consultation integration is not configured.', 'INTEGRATION_NOT_CONFIGURED');
    if (!secureEqual(request.headers.get('x-anjoora-integration-key'), expectedSecret)) {
      throw new HttpError(401, 'Invalid integration credentials.', 'INTEGRATION_UNAUTHORIZED');
    }
    authenticated = true;

    const sourceIp = requestIp(request, { trustIntegrationHeader: true });
    await enforceRateLimit({ scope: 'consultation-ip', key: sourceIp, limit: 10, windowSeconds: 900 });
    const input = await readJsonBody(request);

    let normalized;
    try {
      normalized = normalizeConsultationPayload(input);
    } catch (error) {
      if (error instanceof ConsultationInputError) {
        throw new HttpError(422, error.message, 'VALIDATION_FAILED');
      }
      throw error;
    }
    const existing = (await query(`SELECT submission_response FROM consultations WHERE submission_id=$1 LIMIT 1`, [normalized.submissionId])).rows[0];
    if (existing?.submission_response) {
      return Response.json(existing.submission_response, {
        status: 200,
        headers: { 'X-Request-Id': correlation, 'Idempotent-Replayed': 'true' },
      });
    }
    await enforceRateLimit({ scope: 'consultation-phone', key: normalized.phone, limit: 5, windowSeconds: 3600 });

    const result = await submitConsultation({
      input,
      normalized,
      request,
      sourceIpHash: hashPrivateValue(sourceIp),
      correlation,
    });
    return Response.json(result.response, {
      status: result.replayed ? 200 : 201,
      headers: {
        'X-Request-Id': correlation,
        'Idempotent-Replayed': result.replayed ? 'true' : 'false',
      },
    });
  } catch (error) {
    if (authenticated) {
      try {
        await writeAudit({ query }, {
          request,
          entityType: 'CONSULTATION_SUBMISSION',
          action: 'REJECTED',
          outcome: 'REJECTED',
          correlation,
          payload: { code: error.code || 'UNEXPECTED_ERROR' },
        });
      } catch (auditError) {
        console.error('Could not audit rejected consultation submission', auditError);
      }
    }
    const response = errorResponse(error);
    response.headers.set('X-Request-Id', correlation);
    if (error.retryAfter) response.headers.set('Retry-After', String(error.retryAfter));
    return response;
  }
}

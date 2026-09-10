import { consultationConsentPolicy } from '@/lib/consultation-input';

export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    return Response.json(consultationConsentPolicy(), { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    console.error('Consent policy configuration failed', error);
    return Response.json({ error: 'Consent policy is unavailable.' }, {
      status: 503,
      headers: { 'Cache-Control': 'no-store' },
    });
  }
}

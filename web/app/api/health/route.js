import { query } from '@/lib/db';

export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    await query('SELECT 1');
    return Response.json({ ok: true, service: 'anjoora-ops' }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    console.error('Health check database failure', error);
    return Response.json({ ok: false, service: 'anjoora-ops' }, { status: 503, headers: { 'Cache-Control': 'no-store' } });
  }
}

export async function POST(request) {
  if (process.env.ENABLE_DEMO_FORM !== 'true') {
    return Response.json({ ok: false, error: 'Demo consultation submission is disabled.' }, { status: 404 });
  }
  const body = await request.text();
  if (Buffer.byteLength(body, 'utf8') > 32_768) {
    return Response.json({ ok: false, error: 'Consultation payload is too large.' }, { status: 413 });
  }
  try {
    const response = await fetch(new URL('/api/v1/consultations', request.url), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Anjoora-Integration-Key': process.env.ANJOORA_INTEGRATION_SECRET || '',
        'X-Anjoora-Client-Ip': String(request.headers.get('x-forwarded-for') || request.headers.get('x-real-ip') || 'local-demo').split(',')[0].trim(),
        'X-Request-Id': crypto.randomUUID(),
      },
      body,
      cache: 'no-store',
      signal: AbortSignal.timeout(15_000),
    });
    return new Response(await response.text(), {
      status: response.status,
      headers: { 'Content-Type': response.headers.get('content-type') || 'application/json' },
    });
  } catch (error) {
    console.error('Demo consultation proxy failed', error);
    return Response.json({ ok: false, error: 'Consultation service is temporarily unavailable.' }, { status: 502 });
  }
}

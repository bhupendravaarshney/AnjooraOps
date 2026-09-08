import { query } from '@/lib/db';
import { handleInbound } from '@/lib/bot';
import { deliverWhatsAppJob } from '@/lib/whatsapp';
import { claimNextOutboxJob, completeOutboxJob, failOutboxJob } from '@/lib/outbox';
import { secureEqual } from '@/lib/http';

export async function POST(request) {
  const auth = request.headers.get('authorization');
  const expected = process.env.CRON_SECRET ? `Bearer ${process.env.CRON_SECRET}` : '';
  if (!expected || !secureEqual(auth, expected)) {
    return new Response('Unauthorized', { status: 401 });
  }
  const maximum = Math.min(100, Math.max(1, Number(new URL(request.url).searchParams.get('limit') || 20)));
  const results = { processed: 0, failed: 0, dead: 0 };

  for (let index = 0; index < maximum; index += 1) {
    const job = await claimNextOutboxJob();
    if (!job) break;
    try {
      if (job.job_type === 'BOT_INBOUND') {
        const customer = (await query(`SELECT * FROM customers WHERE id=$1`, [job.payload.customerId])).rows[0];
        const conversation = (await query(`SELECT * FROM whatsapp_conversations WHERE id=$1`, [job.payload.conversationId])).rows[0];
        if (!customer || !conversation) throw new Error('Inbound job context no longer exists.');
        await handleInbound({ messageId: job.payload.messageId, customer, conversation, text: job.payload.text });
      } else {
        await deliverWhatsAppJob(job);
      }
      await completeOutboxJob(job.id);
      results.processed += 1;
    } catch (error) {
      const failed = await failOutboxJob(job, error);
      results.failed += 1;
      if (failed.dead) results.dead += 1;
    }
  }
  return Response.json({ ok: true, ...results });
}

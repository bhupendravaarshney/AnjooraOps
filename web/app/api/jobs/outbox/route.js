import { query } from '@/lib/db';
import { handleInbound } from '@/lib/bot';
import { deliverWhatsAppJob } from '@/lib/whatsapp';
import { claimNextOutboxJob, completeOutboxJob, failOutboxJob } from '@/lib/outbox';
import { cronAuthorized, runOperationalJob } from '@/lib/jobs';

export async function POST(request) {
  if (!cronAuthorized(request)) return new Response('Unauthorized', { status: 401 });
  const maximum = Math.min(100, Math.max(1, Number(new URL(request.url).searchParams.get('limit') || 20)));
  try {
    const results = await runOperationalJob('outbox', async () => {
      const counts = { processed: 0, failed: 0, dead: 0 };

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
          counts.processed += 1;
        } catch (error) {
          const failed = await failOutboxJob(job, error);
          counts.failed += 1;
          if (failed.dead) counts.dead += 1;
        }
      }
      return counts;
    });
    return Response.json({ ok: true, ...results });
  } catch (error) {
    console.error('Outbox job failed', error);
    return Response.json({ ok: false, error: 'Outbox job failed.' }, { status: 500 });
  }
}

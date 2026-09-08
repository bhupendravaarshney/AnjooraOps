import { query, withTransaction } from '@/lib/db';
import { uuid } from '@/lib/ids';

export async function enqueueOutbox(db, { jobType, dedupeKey, payload, maxAttempts = 5 }) {
  const inserted = await db.query(`
    INSERT INTO message_outbox(id,job_type,dedupe_key,payload,max_attempts)
    VALUES($1,$2,$3,$4::jsonb,$5)
    ON CONFLICT(dedupe_key) DO NOTHING
    RETURNING *
  `, [uuid(), jobType, dedupeKey, JSON.stringify(payload), maxAttempts]);
  if (inserted.rows[0]) return { job: inserted.rows[0], created: true };
  const existing = await db.query(`SELECT * FROM message_outbox WHERE dedupe_key=$1`, [dedupeKey]);
  return { job: existing.rows[0], created: false };
}

export async function claimNextOutboxJob() {
  return withTransaction(async (db) => {
    const { rows } = await db.query(`
      WITH candidate AS (
        SELECT id
        FROM message_outbox
        WHERE (
          status IN ('PENDING','FAILED')
          OR (status='PROCESSING' AND locked_at < now() - interval '5 minutes')
        )
          AND next_attempt_at <= now()
          AND attempts < max_attempts
        ORDER BY created_at, id
        FOR UPDATE SKIP LOCKED
        LIMIT 1
      )
      UPDATE message_outbox o
      SET status='PROCESSING', attempts=o.attempts+1, locked_at=now(), updated_at=now()
      FROM candidate
      WHERE o.id=candidate.id
      RETURNING o.*
    `);
    return rows[0] || null;
  });
}

export async function completeOutboxJob(id) {
  await query(`
    UPDATE message_outbox
    SET status='SENT',processed_at=now(),locked_at=NULL,last_error=NULL,updated_at=now()
    WHERE id=$1
  `, [id]);
}

export async function failOutboxJob(job, error) {
  const message = String(error?.message || error || 'Unknown outbox error').slice(0, 1000);
  const dead = Number(job.attempts) >= Number(job.max_attempts);
  const delaySeconds = Math.min(900, 5 * (2 ** Math.max(0, Number(job.attempts) - 1)));
  await query(`
    UPDATE message_outbox
    SET status=$1,last_error=$2,locked_at=NULL,
        next_attempt_at=now()+($3 * interval '1 second'),updated_at=now()
    WHERE id=$4
  `, [dead ? 'DEAD' : 'FAILED', message, delaySeconds, job.id]);
  return { dead, message };
}


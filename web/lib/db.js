import pg from 'pg';

const { Pool } = pg;

const globalForDb = globalThis;

function sslConfig() {
  if (process.env.DATABASE_SSL === 'true') {
    return {
      rejectUnauthorized: true,
      ...(process.env.DATABASE_CA_CERT ? { ca: process.env.DATABASE_CA_CERT.replace(/\\n/g, '\n') } : {}),
    };
  }
  return undefined;
}

export const pool = globalForDb.__anjooraPool || new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: sslConfig(),
  max: Number(process.env.DB_POOL_MAX || 10),
});

if (process.env.NODE_ENV !== 'production') globalForDb.__anjooraPool = pool;

export async function query(text, params = []) {
  return pool.query(text, params);
}

export async function withTransaction(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

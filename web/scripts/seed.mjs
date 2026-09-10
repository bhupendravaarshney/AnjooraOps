import crypto from 'crypto';
import pg from 'pg';
import './load-env.mjs';

const { Client } = pg;
const client = new Client({ connectionString: process.env.DATABASE_URL, ssl: process.env.DATABASE_SSL === 'true' ? { rejectUnauthorized: true, ...(process.env.DATABASE_CA_CERT ? { ca: process.env.DATABASE_CA_CERT.replace(/\\n/g, '\n') } : {}) } : undefined });
const publicId = (p) => `${p}-SEED-${crypto.randomBytes(16).toString('hex').toUpperCase()}`;
await client.connect();
try {
  const products = [
    ['ANJ-SLEEP-INF-01','Sleep Infusion','infusion',30],
    ['ANJ-CALM-INF-01','Calm Infusion','infusion',30]
  ];
  for (const [sku,name,format,duration] of products) {
    await client.query(`INSERT INTO products(id,public_id,sku,name,format,default_duration_days) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(sku) DO NOTHING`, [crypto.randomUUID(),publicId('ANJ-PROD'),sku,name,format,duration]);
  }
  const inventory = [
    ['RM-ASHWAGANDHA','Ashwagandha','g',500],
    ['RM-BRAHMI','Brahmi','g',500],
    ['RM-JATAMANSI','Jatamansi','g',250],
    ['PK-INFUSION-POUCH','Infusion pouch','unit',25],
    ['FG-SLEEP-INF-01','Sleep Infusion finished unit','unit',10],
    ['FG-CALM-INF-01','Calm Infusion finished unit','unit',10]
  ];
  for (const [sku,name,unit,reorder] of inventory) {
    const id = crypto.randomUUID();
    await client.query(`INSERT INTO inventory_items(id,public_id,sku,name,unit,reorder_level) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(sku) DO NOTHING`, [id,publicId('ANJ-INV'),sku,name,unit,reorder]);
  }
  const { rows } = await client.query(`SELECT id,sku,name FROM inventory_items WHERE sku IN ('RM-ASHWAGANDHA','RM-BRAHMI','RM-JATAMANSI','PK-INFUSION-POUCH','FG-SLEEP-INF-01','FG-CALM-INF-01')`);
  for (const row of rows) {
    const exists = await client.query(`SELECT 1 FROM inventory_transactions WHERE inventory_item_id=$1 AND reference='INITIAL-SEED'`, [row.id]);
    if (!exists.rowCount) await client.query(`INSERT INTO inventory_transactions(id,inventory_item_id,transaction_type,quantity,reference,note) VALUES($1,$2,'RECEIPT',1000,'INITIAL-SEED','Demo opening stock')`, [crypto.randomUUID(),row.id]);
    if (row.sku.startsWith('RM-')) {
      await client.query(`
        INSERT INTO formula_ingredients(id,public_id,inventory_item_id,name)
        VALUES($1,$2,$3,$4)
        ON CONFLICT(inventory_item_id) DO NOTHING
      `, [crypto.randomUUID(),publicId('ANJ-FING'),row.id,row.name]);
    }
  }
  await client.query(`UPDATE products p SET inventory_item_id=i.id,inventory_quantity=1,updated_at=now() FROM inventory_items i WHERE (p.sku='ANJ-SLEEP-INF-01' AND i.sku='FG-SLEEP-INF-01') OR (p.sku='ANJ-CALM-INF-01' AND i.sku='FG-CALM-INF-01')`);
  console.log('Seed data ready.');
} finally { await client.end(); }

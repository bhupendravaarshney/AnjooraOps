import fs from 'node:fs';
import path from 'node:path';

const databaseWasConfigured = Boolean(process.env.DATABASE_URL);
const candidates = [path.resolve(process.cwd(), '.env'), path.resolve(process.cwd(), '../.env')];
const environmentFile = candidates.find((candidate) => fs.existsSync(candidate));

if (environmentFile) {
  for (const sourceLine of fs.readFileSync(environmentFile, 'utf8').split(/\r?\n/)) {
    const line = sourceLine.trim();
    if (!line || line.startsWith('#') || !/^[A-Za-z_][A-Za-z0-9_]*=/.test(line)) continue;
    const separator = line.indexOf('=');
    const name = line.slice(0, separator);
    if (process.env[name] !== undefined) continue;
    let value = line.slice(separator + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    process.env[name] = value;
  }
}

// Compose resolves the service name internally. Host-run maintenance and test
// scripts use the same local file but connect through the loopback port.
if (!databaseWasConfigured && process.env.DATABASE_URL) {
  try {
    const database = new URL(process.env.DATABASE_URL);
    const app = new URL(process.env.APP_URL || process.env.NEXT_PUBLIC_APP_URL || 'http://localhost');
    if (database.hostname === 'postgres' && ['localhost', '127.0.0.1'].includes(app.hostname)) {
      database.hostname = '127.0.0.1';
      process.env.DATABASE_URL = database.toString();
    }
  } catch {
    // Validation in the calling script reports malformed required values.
  }
}

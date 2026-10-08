import { getConfig } from '../server/config.js';
import { openDb, migrate } from '../server/db.js';
const db = await openDb(getConfig());
try {
  await migrate(db);
  console.log('Database migrated.');
} finally {
  await db.close();
}

import { runMigrations, closeDb } from './services/db.js';
console.log('Running database migrations...');
await runMigrations();
console.log('Migrations complete.');
closeDb();

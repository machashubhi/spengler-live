// Upload a prepared match file to the private R2 bucket.   npm run upload -- <match-id> [--local]
import { execSync } from 'node:child_process';
import { existsSync } from 'node:fs';

const [id, where = '--remote'] = process.argv.slice(2);
if (!/^[a-z0-9-]+$/.test(id || '') || !existsSync(`data/${id}.json`)) {
  console.error('usage: npm run upload -- <match-id> [--local]   (expects data/<match-id>.json)');
  process.exit(1);
}
// one command string so it runs the same way on Windows, macOS and Linux (id is validated above)
execSync(`npx wrangler r2 object put spengler-live-data/${id}.json --file data/${id}.json --content-type application/json ${where === '--local' ? '--local' : '--remote'}`, { stdio: 'inherit' });

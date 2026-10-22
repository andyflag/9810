import { execFileSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
const root = path.resolve(import.meta.dirname, '..');
mkdirSync(path.join(root, 'outputs'), { recursive: true });
const archive = path.join(root, 'outputs/site.tar.gz');
execFileSync('tar', ['-czf', archive, '.openai', 'dist/server', 'drizzle'], { cwd: root });
console.log(archive);

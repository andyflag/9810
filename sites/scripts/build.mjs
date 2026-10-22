import { readFile, writeFile, mkdir, readdir, cp, rm } from 'node:fs/promises';
import path from 'node:path';
import { build } from 'esbuild';
const root = path.resolve(import.meta.dirname, '..');
const assets = {};
async function collect(directory, prefix = '') {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const relative = prefix + '/' + entry.name,
      full = path.join(directory, entry.name);
    if (entry.isDirectory()) await collect(full, relative);
    else
      assets[relative] = {
        content: (await readFile(full)).toString('base64'),
        type: entry.name.endsWith('.html')
          ? 'text/html; charset=utf-8'
          : entry.name.endsWith('.js')
            ? 'text/javascript; charset=utf-8'
            : entry.name.endsWith('.css')
              ? 'text/css; charset=utf-8'
              : 'application/octet-stream',
      };
  }
}
await collect(path.join(root, 'frontend/dist'));
assets['/template.xlsx'] = {
  content: (await readFile(path.join(root, 'template.xlsx'))).toString('base64'),
  type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
};
await writeFile(path.join(root, 'server/assets.json'), JSON.stringify(assets));
await rm(path.join(root, 'dist'), { recursive: true, force: true });
await mkdir(path.join(root, 'dist/server'), { recursive: true });
await mkdir(path.join(root, 'dist/.openai'), { recursive: true });
await build({
  entryPoints: [path.join(root, 'server/index.ts')],
  outfile: path.join(root, 'dist/server/index.js'),
  bundle: true,
  format: 'esm',
  platform: 'browser',
  target: 'es2022',
  minify: true,
  logLevel: 'info',
});
await cp(path.join(root, '.openai/hosting.json'), path.join(root, 'dist/.openai/hosting.json'));
await cp(path.join(root, 'drizzle'), path.join(root, 'dist/drizzle'), { recursive: true });
await writeFile(path.join(root, 'dist/server/package.json'), JSON.stringify({ type: 'module' }));
console.log('Sites artifact ready: dist/server/index.js + manifest + migrations');

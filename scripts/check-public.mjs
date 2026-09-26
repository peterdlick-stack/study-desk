import { readdir, readFile } from 'node:fs/promises';
import { extname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('..', import.meta.url));
const excluded = new Set(['.git', '.local', 'node_modules']);
const failures = [], files = [];
async function walk(directory) {
  for (const item of await readdir(directory, { withFileTypes: true })) {
    if (excluded.has(item.name)) continue;
    const path = join(directory, item.name), rel = relative(root, path).replaceAll('\\', '/');
    if (item.isDirectory()) { await walk(path); continue; }
    files.push(rel);
    if (/^(?:\.env(?:\.|$)|.*\.(?:dpapi|pem|key)$)/i.test(item.name) || /(?:^|\/)(?:\.edge-[^/]*|__pycache__|qa)\//.test(rel)) failures.push(`${rel}: private/runtime file`);
    if (!['.js', '.mjs', '.json', '.md', '.html', '.css', '.yml', '.txt'].includes(extname(path)) || rel.startsWith('vendor/')) continue;
    const text = await readFile(path, 'utf8');
    const patterns = [ /(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,})/, /sk-[A-Za-z0-9_-]{30,}/,
      /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/, /[A-Z]:[\\/]+Users[\\/]+(?:admin|[^\\/\s]+)[\\/]/i ];
    if (rel !== 'scripts/check-public.mjs' && patterns.some(p => p.test(text))) failures.push(`${rel}: credential-shaped text or personal absolute path`);
  }
}
await walk(root);
if (failures.length) { console.error(failures.join('\n')); process.exitCode = 1; }
else console.log(`Public-file check passed (${files.length} files). Pattern scan only; not a comprehensive security audit.`);

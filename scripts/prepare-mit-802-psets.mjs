#!/usr/bin/env node
// Download only PDF links actually present on the official 2002 problem-set page.
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const INDEX_URL = 'https://web.mit.edu/8.02/www/Spring02/probsets.htm';
const PROJECT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUTPUT = resolve(PROJECT, '.local/study-library/practice/sources/mit-802-spring2002');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');

export function parsePsetLinks(html) {
  const resources = new Map();
  for (const match of html.matchAll(/href\s*=\s*["']([^"']+\.pdf)["']/gi)) {
    const url = new URL(match[1], INDEX_URL);
    if (url.origin !== 'https://web.mit.edu' || !url.pathname.startsWith('/8.02/www/Spring02/problemsets/')) continue;
    const filename = basename(url.pathname);
    const details = filename.match(/^ps(s?)(\d+)[a-z]?\.pdf$/i);
    if (!details) continue;
    resources.set(url.href, { url: url.href, filename, setNumber: Number(details[2]), role: details[1] ? 'solution' : 'problem' });
  }
  return [...resources.values()].sort((a, b) => a.setNumber - b.setNumber || a.role.localeCompare(b.role));
}

export async function preparePsets({ output = OUTPUT, fetcher = fetch } = {}) {
  const response = await fetcher(INDEX_URL);
  if (!response.ok) throw new Error(`Official PSET index returned ${response.status}`);
  const html = await response.text();
  const links = parsePsetLinks(html);
  if (!links.length) throw new Error('No recognized official PDF links; nothing imported.');
  output = resolve(output);
  await mkdir(output, { recursive: true });
  const documents = [];
  for (const resource of links) {
    const path = join(output, resource.filename);
    let bytes, retained = false;
    try { bytes = await readFile(path); retained = true; } catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (!bytes) {
      const fileResponse = await fetcher(resource.url);
      if (!fileResponse.ok) throw new Error(`${resource.filename}: HTTP ${fileResponse.status}`);
      bytes = Buffer.from(await fileResponse.arrayBuffer());
      if (bytes.length < 5 || bytes.subarray(0, 5).toString() !== '%PDF-') throw new Error(`${resource.filename}: response is not a PDF; not saved.`);
      await writeFile(path, bytes, { flag: 'wx' });
    }
    if (bytes.subarray(0, 5).toString() !== '%PDF-') throw new Error(`${resource.filename}: existing file is not a PDF; retained unchanged.`);
    documents.push({ ...resource, path, bytes: bytes.length, sha256: hash(bytes), status: retained ? 'retained-existing' : 'downloaded', contentReview: 'not-fully-reviewed' });
  }
  // Each run creates a new manifest; source PDFs and older evidence are never overwritten.
  const manifest = {
    schemaVersion: 1, sourceId: 'mit-802-lewin-pset', title: 'MIT 8.02 Spring 2002 — Walter Lewin PSET',
    courseUrl: 'https://web.mit.edu/8.02/www/Spring02/', indexUrl: INDEX_URL,
    preparedAt: new Date().toISOString(), downloadStatus: 'available', splitStatus: 'pending', lessonMappingStatus: 'pending',
    note: '官方 Spring02 目录及讲师信息已核对。这里只准备整份题面与答案，不宣称拆题、逐讲匹配或每题答案核验完成。第 11 份只有答案链接，题面缺失保持记录。',
    documents,
    sets: [...new Set(documents.map(doc => doc.setNumber))].map(number => ({
      number, problem: documents.find(doc => doc.setNumber === number && doc.role === 'problem')?.filename ?? null,
      solution: documents.find(doc => doc.setNumber === number && doc.role === 'solution')?.filename ?? null,
    })),
  };
  const path = join(output, `manifest-${Date.now()}-${randomUUID()}.json`);
  await writeFile(path, JSON.stringify(manifest, null, 2) + '\n', { encoding: 'utf8', flag: 'wx' });
  return { output, manifestPath: path, documentCount: documents.length, sets: manifest.sets };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2);
    if (args.length && (args.length !== 2 || args[0] !== '--output')) throw new Error('Usage: node scripts/prepare-mit-802-psets.mjs [--output NEW_OR_EXISTING_DIR]');
    console.log(JSON.stringify(await preparePsets({ output: args[1] ?? OUTPUT }), null, 2));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}

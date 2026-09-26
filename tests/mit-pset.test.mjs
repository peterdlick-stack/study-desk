import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { parsePsetLinks, preparePsets, INDEX_URL } from '../scripts/prepare-mit-802-psets.mjs';

test('discovers only official same-term PSET PDFs and preserves missing question sheets', () => {
  const links = parsePsetLinks(`<a href="problemsets/ps1a.pdf">question</a><a href="problemsets/pss1.pdf">answer</a>
    <a href="problemsets/pss11.pdf">answer 11</a><a href="exams/exam.pdf">exam</a>
    <a href="https://elsewhere.example/8.02/www/Spring02/problemsets/ps2a.pdf">other</a>
    <a href="../Spring03/problemsets/ps2a.pdf">wrong year</a><a href="problemsets/ps1a.pdf">duplicate</a>`);
  assert.equal(links.length, 3);
  assert.deepEqual(links.map(link => [link.setNumber, link.role]), [[1, 'problem'], [1, 'solution'], [11, 'solution']]);
});

test('PDF import saves source provenance, rejects HTML and does not overwrite existing PDFs', async t => {
  const output = await mkdtemp(join(tmpdir(), 'study-desk-mit-pset-'));
  t.after(() => rm(output, { recursive: true, force: true }));
  const fetcher = async url => url === INDEX_URL
    ? { ok: true, text: async () => '<a href="problemsets/ps1a.pdf">PDF</a>' }
    : { ok: true, arrayBuffer: async () => Buffer.from('%PDF-1.4\nfixture') };
  const first = await preparePsets({ output, fetcher });
  assert.equal(first.documentCount, 1);
  const manifest = JSON.parse(await readFile(first.manifestPath, 'utf8'));
  assert.equal(manifest.documents[0].sha256.length, 64);
  assert.equal(manifest.sets[0].solution, null);
  assert.equal(manifest.splitStatus, 'pending');
  const original = await readFile(join(output, 'ps1a.pdf'), 'utf8');
  const second = await preparePsets({ output, fetcher: async url => {
    assert.equal(url, INDEX_URL, 'existing PDFs must not be fetched or overwritten');
    return fetcher(url);
  } });
  assert.equal(await readFile(join(output, 'ps1a.pdf'), 'utf8'), original);
  assert.notEqual(first.manifestPath, second.manifestPath);
  await assert.rejects(() => preparePsets({ output, fetcher: async url => url === INDEX_URL
    ? { ok: true, text: async () => '<a href="problemsets/ps2a.pdf">PDF</a>' }
    : { ok: true, arrayBuffer: async () => Buffer.from('<html>not a PDF</html>') } }), /not a PDF/);
  assert.ok(!(await readdir(output)).includes('ps2a.pdf'));
});

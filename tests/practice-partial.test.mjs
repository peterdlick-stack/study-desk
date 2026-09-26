import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { PracticeStore } from '../lib/practice.mjs';
import { createCodexPracticeGrader } from '../lib/practice-grader.mjs';
test('Windows grading timeout terminates the launcher and its native child', { skip: process.platform !== 'win32' }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'practice-timeout-')), cli = join(root, 'launcher.mjs'), pidFile = join(root, 'child-pid.txt');
  await writeFile(cli, `import {spawn} from 'node:child_process'; import {writeFile} from 'node:fs/promises'; const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{windowsHide:true,stdio:'ignore'}); await writeFile(${JSON.stringify(pidFile)},String(child.pid)); setInterval(()=>{},1000);`);
  const grader = createCodexPracticeGrader({ codexPath: cli, timeoutMs: 1500 });
  await assert.rejects(grader({ attempt: { pages: [], conditions: {} }, item: { title: 'Synthetic timeout', prompt: '', topicIds: [] } }), /超时/);
  const pid = Number(await readFile(pidFile, 'utf8'));
  assert.throws(() => process.kill(pid, 0), /ESRCH/);
});
test('a failed second CLI run preserves the first raw report without creating evidence', async () => {
  const root = await mkdtemp(join(tmpdir(), 'practice-partial-'));
  const cli = join(root, 'fake-codex.mjs');
  await writeFile(cli, `import {writeFile} from 'node:fs/promises'; let p=''; for await(const c of process.stdin)p+=c; if(p.includes('FIRST_REPORT_JSON'))process.exit(7); const args=process.argv.slice(2); const grade={verdict:'correct',summary:'FIRST_REPORT_PRESERVED',recognizedWork:'2',steps:[],errorTopicIds:[],uncertainties:[],hint:'next',solution:'2',verification:{status:'verified',reason:'synthetic'}}; await writeFile(args[args.indexOf('--output-last-message')+1],JSON.stringify(grade));`);
  await mkdir(join(root, 'practice'));
  await writeFile(join(root, 'practice/catalog.json'), JSON.stringify({ schemaVersion: 1, sources: [{ id: 's', title: 'synthetic', status: 'available', kind: 'local' }], topics: [], items: [{ id: 'q', title: 'test', sourceId: 's', sourceRef: 'test', prompt: '1+1', referenceAnswer: '2', topicIds: [], unitId: 'u', track: '8.01', kind: 'supplement', sourceQuality: 'UNKNOWN', locator: { path: 'synthetic' } }] }));
  const store = new PracticeStore({ courseRoot: root, grader: createCodexPracticeGrader({ codexPath: cli }) });
  await store.submit({ id: 'a', itemId: 'q', lessonId: 'l', pages: [{ objects: [], image: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/yXcAAAAASUVORK5CYII=' }], conditions: { closedBook: null, firstSeen: null, guessed: null } });
  await store.waitForIdle();
  assert.equal((await store.get('a')).state, 'failed');
  assert.equal((await store.get('a')).grade, null);
  const dir = join(root, 'practice/attempts/a/runs/0001');
  const name = (await readdir(dir)).find(n => n.startsWith('failure-'));
  const saved = JSON.parse(await readFile(join(dir, name), 'utf8'));
  assert.equal(saved.partialReports.length, 1);
  assert.match(saved.partialReports[0].rawText, /FIRST_REPORT_PRESERVED/);
});

test('successful CLI grading captures and totals both turn.completed usage events', async () => {
  const root = await mkdtemp(join(tmpdir(), 'practice-usage-'));
  const cli = join(root, 'fake-codex.mjs');
  await writeFile(cli, `import {writeFile} from 'node:fs/promises'; let p=''; for await(const c of process.stdin)p+=c; const second=p.includes('FIRST_REPORT_JSON'); const args=process.argv.slice(2); const grade={verdict:'correct',summary:'USAGE_CAPTURED',recognizedWork:'2',steps:[],errorTopicIds:[],uncertainties:[],hint:'next',solution:'2',verification:{status:'verified',reason:'synthetic'}}; await writeFile(args[args.indexOf('--output-last-message')+1],JSON.stringify(grade)); const usage=second?{input_tokens:120,cached_input_tokens:50,output_tokens:25,reasoning_output_tokens:6}:{input_tokens:100,cached_input_tokens:40,output_tokens:20,reasoning_output_tokens:5}; process.stdout.write(JSON.stringify({type:'turn.completed',usage})+'\\n');`);
  const grader = createCodexPracticeGrader({ codexPath: cli });
  const result = await grader({ attempt: { pages: [], conditions: {} }, item: { title: 'Synthetic usage', prompt: '', referenceAnswer: '', sourceRef: 'test', sourceQuality: 'UNKNOWN', topicIds: [] } });
  assert.equal(result.usage.status, 'complete');
  assert.deepEqual(result.usage.totals, { input_tokens: 220, cached_input_tokens: 90, output_tokens: 45, reasoning_output_tokens: 11, total_tokens: 265 });
  assert.equal(result.reports[0].usage.input_tokens, 100);
  assert.equal(result.reports[1].usage.input_tokens, 120);
});

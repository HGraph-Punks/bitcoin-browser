import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, rm, readFile, writeFile, symlink, mkdir} from 'node:fs/promises';
import {randomUUID, createHash} from 'node:crypto';
import path from 'node:path';
import os from 'node:os';
import {DraftStore} from '../source/core/draft-store';
import {ProjectStore} from '../source/core/project-store';

test('draft recovery survives restart without changing source; an older acknowledgement cannot remove a newer draft', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'btcsite-drafts-'));
  const projects = new ProjectStore(path.join(root, 'projects')); await projects.initialize();
  try {
    const project = await projects.create({title: 'Recovery', template: 'blank'});
    const first = {projectId: project.id, path: 'index.html', id: randomUUID(), baseRevision: 0, content: '<p>Draft 🌕\r\n</p>\n'};
    let drafts = new DraftStore(path.join(root, 'drafts')); await drafts.initialize();
    await drafts.save(first); const second = {...first, id: randomUUID(), content: '<p>Newer intent</p>'};
    await drafts.save(second); assert.equal((await drafts.remove({projectId: first.projectId, path: first.path, id: first.id})).removed, false);
    await drafts.close(); drafts = new DraftStore(path.join(root, 'drafts')); await drafts.initialize();
    const recovered = await drafts.list(project.id); assert.equal(recovered.length, 1); assert.equal(recovered[0].content, second.content); assert.equal(recovered[0].baseRevision, 0);
    assert.deepEqual((await projects.read(project.id)).files, project.files); assert.equal((await projects.read(project.id)).revision, 0);
    assert.equal((await drafts.remove({projectId: project.id, path: first.path, id: second.id})).removed, true); assert.deepEqual(await drafts.list(project.id), []);
    await drafts.close();
  } finally {await projects.close(); await rm(root, {recursive: true, force: true});}
});

test('draft identity, hashes, byte limits, and directory boundaries fail closed', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'btcsite-draft-bounds-'));
  try {
    const drafts = new DraftStore(path.join(root, 'drafts')); await drafts.initialize();
    const projectId = randomUUID(), record = {projectId, path: 'index.html', id: randomUUID(), baseRevision: 1, content: '<p>Keep me</p>'};
    await drafts.save(record);
    await assert.rejects(drafts.save({...record, path: '../escape.html'}));
    await assert.rejects(drafts.save({...record, content: '🌕'.repeat(500_001)}), /2 MB/);
    const filename = path.join(root, 'drafts', projectId, createHash('sha256').update(record.path).digest('hex') + '.json');
    const saved = JSON.parse(await readFile(filename, 'utf8')); saved.content = 'altered'; await writeFile(filename, JSON.stringify(saved));
    await assert.rejects(drafts.list(projectId), /identity or content/);
    const other = randomUUID(), outside = path.join(root, 'outside'); await mkdir(outside); await symlink(outside, path.join(root, 'drafts', other));
    await assert.rejects(drafts.save({...record, projectId: other}), /symbolic links/);
    await drafts.close();
  } finally {await rm(root, {recursive: true, force: true});}
});

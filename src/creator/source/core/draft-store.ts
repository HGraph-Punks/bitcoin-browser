import {mkdir, readdir, lstat, rm, open, realpath} from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {z} from 'zod';
import {atomicWrite} from './project-store';
import {AppError} from './errors';
import {readInputFile} from './input-files';
import {projectId, safeRelativePath, validate} from './validation';
import {isTextFile} from './assets';

export const draftInput = z.object({projectId, path: z.string().min(1).max(240)}).strict();
export const draftSaveInput = draftInput.extend({id: z.string().uuid(), baseRevision: z.number().int().min(0).max(2_147_483_647), content: z.string().max(2_000_000)}).strict();
export const draftRemoveInput = draftInput.extend({id: z.string().uuid()}).strict();
const recordSchema = draftSaveInput.extend({schemaVersion: z.literal(1), updatedAt: z.string().datetime(), sha256: z.string().regex(/^[a-f0-9]{64}$/)}).strict();
export type SourceDraft = z.infer<typeof recordSchema>;
const hash = (text: string) => createHash('sha256').update(text).digest('hex');

/** Desktop-only recovery copies. They never advance source or publication history. */
export class DraftStore {
  private queues = new Map<string, Promise<unknown>>();
  constructor(private root: string) {}
  async initialize() {await this.directory(this.root); this.root = await realpath(this.root);}
  private async directory(directory: string) {
    await mkdir(directory, {recursive: true, mode: 0o700});
    if ((await lstat(directory)).isSymbolicLink()) throw new AppError('UNSAFE_PATH', 'Draft recovery directories cannot be symbolic links.');
    return directory;
  }
  private filename(project: string, relative: string) {
    validate(projectId, project); safeRelativePath(relative);
    if (!isTextFile(relative)) throw new AppError('TEXT_FILE_REQUIRED', 'Recovery copies support text source files.');
    return path.join(this.root, project, hash(relative) + '.json');
  }
  private serialize<T>(project: string, operation: () => Promise<T>): Promise<T> {
    const task = (this.queues.get(project) ?? Promise.resolve()).catch(() => {}).then(operation);
    this.queues.set(project, task);
    void task.finally(() => {if (this.queues.get(project) === task) this.queues.delete(project);}).catch(() => {});
    return task;
  }
  private async records(project: string): Promise<SourceDraft[]> {
    validate(projectId, project);
    const directory = path.join(this.root, project);
    let names: string[];
    try {
      if ((await lstat(directory)).isSymbolicLink()) throw new AppError('UNSAFE_PATH', 'Draft recovery directories cannot be symbolic links.');
      names = await readdir(directory);
    } catch (error) {if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error;}
    const files = names.filter(name => /^[a-f0-9]{64}\.json$/.test(name));
    if (files.length > 64) throw new AppError('DRAFT_LIMIT', 'This project has too many recovery copies. Export and resolve them before continuing.');
    const result: SourceDraft[] = []; let bytes = 0;
    for (const name of files) {
      const record = validate(recordSchema, JSON.parse((await readInputFile(path.join(directory, name), 12_100_000, this.root)).toString()));
      if (record.projectId !== project || path.basename(this.filename(project, record.path)) !== name || hash(record.content) !== record.sha256) throw new AppError('DRAFT_DAMAGED', 'A source recovery copy failed its identity or content check.');
      if (Buffer.byteLength(record.content) > 2_000_000) throw new AppError('DRAFT_DAMAGED', 'A source recovery copy exceeds its 2 MB limit.');
      bytes += Buffer.byteLength(record.content);
      if (bytes > 8_000_000) throw new AppError('DRAFT_LIMIT', 'Source recovery copies exceed the 8 MB project limit.');
      result.push(record);
    }
    return result.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }
  list(project: string) {return this.serialize(project, () => this.records(project));}
  save(input: unknown) {
    const value = validate(draftSaveInput, input);
    return this.serialize(value.projectId, async () => {
      const filename = this.filename(value.projectId, value.path);
      if (Buffer.byteLength(value.content) > 2_000_000) throw new AppError('FILE_TOO_LARGE', 'Keep a source recovery copy within 2 MB.');
      const existing = (await this.records(value.projectId)).filter(record => record.path !== value.path);
      if (existing.length >= 64 || existing.reduce((bytes, record) => bytes + Buffer.byteLength(record.content), 0) + Buffer.byteLength(value.content) > 8_000_000) throw new AppError('DRAFT_LIMIT', 'Resolve or export existing recovery copies before adding more source.');
      await this.directory(path.dirname(filename));
      const record: SourceDraft = {...value, schemaVersion: 1, updatedAt: new Date().toISOString(), sha256: hash(value.content)};
      await atomicWrite(filename, JSON.stringify(record));
      return {id: record.id, sha256: record.sha256};
    });
  }
  remove(input: unknown) {
    const value = validate(draftRemoveInput, input);
    return this.serialize(value.projectId, async () => {
      const record = (await this.records(value.projectId)).find(record => record.path === value.path);
      if (!record || record.id !== value.id) return {removed: false};
      const filename = this.filename(value.projectId, value.path); await rm(filename);
      if (process.platform !== 'win32') {const directory = await open(path.dirname(filename), 'r'); try {await directory.sync();} finally {await directory.close();}}
      return {removed: true};
    });
  }
  async close() {await Promise.allSettled(this.queues.values());}
}

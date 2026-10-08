import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { access, constants, mkdir, readdir, rename, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { Transform, type Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { uuidSchema } from '../shared/schemas.js';
import { AppError } from './errors.js';
// Uploads land here first and are renamed into <id>/<filename> only once complete.
const incoming = '.incoming';
const maxNameBytes = 200;
// Keeps the uploaded name as given, minus path parts, control characters, and
// bidirectional overrides that could disguise the extension.
export function pdfFilename(raw: string) {
  let name = (raw.normalize('NFC').split(/[/\\]/).pop() || '')
    .replace(/[\p{Cc}‎‏‪-‮⁦-⁩]/gu, '')
    .trim()
    .replace(/^\.+/, '')
    .trim();
  if (!/\.pdf$/i.test(name)) name += '.pdf';
  if (/^\.pdf$/i.test(name)) name = 'document.pdf';
  const ext = name.slice(-4),
    stem = Array.from(name.slice(0, -4));
  while (Buffer.byteLength(stem.join('') + ext) > maxNameBytes) stem.pop();
  return stem.join('').trimEnd() + ext;
}
export class FileStore {
  constructor(
    public dir: string,
    public maxBytes = 25 * 1024 * 1024,
  ) {}
  async init() {
    await mkdir(join(this.dir, incoming), { recursive: true, mode: 0o700 });
    await access(this.dir, constants.W_OK);
  }
  path(id: string, filename: string) {
    uuidSchema.parse(id);
    return join(this.dir, id, filename);
  }
  open(id: string, filename: string) {
    return createReadStream(this.path(id, filename));
  }
  async save(body: Readable, rawName: string, maxBytes: number) {
    const id = randomUUID(),
      filename = pdfFilename(rawName),
      partial = join(this.dir, incoming, id),
      hash = createHash('sha256');
    let size = 0,
      head = Buffer.alloc(0);
    // PDF readers accept the header anywhere in the first kilobyte.
    const isPdf = () => head.includes('%PDF-');
    const meter = new Transform({
      transform(chunk: Buffer, _encoding, done) {
        size += chunk.length;
        if (size > maxBytes)
          return done(
            new AppError(413, `PDFs can be at most ${Math.floor(maxBytes / 1048576)} MB.`),
          );
        if (head.length < 1024) {
          head = Buffer.concat([head, chunk.subarray(0, 1024 - head.length)]);
          if (head.length === 1024 && !isPdf())
            return done(new AppError(400, 'Only PDF files can be uploaded.'));
        }
        hash.update(chunk);
        done(null, chunk);
      },
    });
    await mkdir(join(this.dir, incoming), { recursive: true, mode: 0o700 });
    try {
      await pipeline(body, meter, createWriteStream(partial, { mode: 0o600 }));
      if (!isPdf()) throw new AppError(400, 'Only PDF files can be uploaded.');
      await mkdir(join(this.dir, id), { mode: 0o700 });
      await rename(partial, this.path(id, filename));
    } catch (err) {
      await rm(partial, { force: true });
      throw err;
    }
    return { id, filename, size, sha256: hash.digest('hex') };
  }
  async remove(id: string) {
    uuidSchema.parse(id);
    await rm(join(this.dir, id), { recursive: true, force: true });
  }
  // Removes folders without a database row and abandoned partial uploads.
  async sweep(known: Set<string>, olderThan: Date) {
    const old = async (path: string) => (await stat(path)).mtime < olderThan;
    for (const name of await readdir(this.dir).catch(() => [])) {
      const path = join(this.dir, name);
      if (name === incoming) {
        for (const part of await readdir(path))
          if (await old(join(path, part))) await rm(join(path, part), { force: true });
      } else if (uuidSchema.safeParse(name).success && !known.has(name) && (await old(path)))
        await rm(path, { recursive: true, force: true });
    }
  }
}

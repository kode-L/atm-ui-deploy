// Reading bulk-mint batch files (a zip, or loose CSVs) into checked, grouped rows.
// Same format as the VoucherDAO bulk uploads: e.g. the rgst_vouchers.py zip, one folder per
// reward, one CSV per batch, and an optional files.csv (file,rows,rgst,sha256) whose sha256s are checked.
import { ethers } from 'ethers';
import { checkRows, csvToRows } from './mint-csv';
import { StoredRow } from './upload-store';
import { readZip, sha256Hex } from './zip-read';

export interface BatchFile { file: string; rows: StoredRow[]; errors: string[]; sha: 'ok' | 'bad' | 'none'; total: ethers.BigNumber; pick: boolean }
export interface BatchGroup { name: string; files: BatchFile[]; pick: boolean }
export interface BatchPreview { source: string; summary?: string; missing: string[]; groups: BatchGroup[] }

export const natural = (a: string, b: string) => a.localeCompare(b, undefined, { numeric: true });

/** fungible: amounts are token units, stored as 18-dp raw values; otherwise whole numbers. */
export async function readBatchFiles(fileList: FileList, fungible: boolean, needsId: boolean): Promise<BatchPreview> {
  // copy now: the FileList is live and empties when the input is reset after picking
  const list = Array.from(fileList);
  const files: { path: string; bytes: Uint8Array; loose?: boolean }[] = [];
  for (const f of list) {
    if (/\.zip$/i.test(f.name)) files.push(...(await readZip(f)));
    else files.push({ path: f.name, bytes: new Uint8Array(await f.arrayBuffer()), loose: true });
  }
  const dec = new TextDecoder();
  const index = files.find((f) => /(^|\/)files\.csv$/i.test(f.path));
  const summary = files.find((f) => /(^|\/)SUMMARY\.txt$/i.test(f.path));
  const root = index ? index.path.replace(/files\.csv$/i, '') : '';
  const shaOf = new Map<string, string>(); // path under root -> sha256
  if (index) {
    for (const line of dec.decode(index.bytes).split(/\r?\n/).slice(1)) {
      const cols = line.split(',').map((c) => c.trim());
      if (cols.length >= 4 && cols[0]) shaOf.set(cols[0], cols[cols.length - 1].toLowerCase());
    }
  }
  // a CSV picked on its own has no folder: find it in files.csv by file name (gives its folder + sha)
  const byName = new Map<string, string[]>();
  for (const rel of Array.from(shaOf.keys())) {
    const base = rel.split('/').pop() as string;
    byName.set(base, [...(byName.get(base) || []), rel]);
  }
  const relOf = (f: { path: string; loose?: boolean }) => {
    if (f.loose) {
      const hits = byName.get(f.path) || [];
      return hits.length === 1 ? hits[0] : f.path;
    }
    return root && f.path.startsWith(root) ? f.path.slice(root.length) : f.path;
  };
  const groups = new Map<string, BatchFile[]>();
  for (const f of files.filter((x) => /\.csv$/i.test(x.path) && x !== index)) {
    const rel = relOf(f);
    const folder = rel.includes('/') ? rel.split('/').slice(0, -1).join('/') : 'files';
    const name = rel.split('/').pop() as string;
    const { rows, errors } = checkRows(csvToRows(dec.decode(f.bytes)), fungible, needsId);
    const stored = rows.map((r) => ({ to: r.to, face: fungible ? ethers.utils.parseUnits(r.amount, 18).toString() : r.amount, tokenId: r.tokenId || '0' }));
    const want = shaOf.get(rel);
    const sha = !want ? 'none' : (await sha256Hex(f.bytes)) === want ? 'ok' : 'bad';
    if (!rows.length && !errors.length) errors.push('no rows');
    const total = stored.reduce((t, r) => t.add(r.face), ethers.BigNumber.from(0));
    groups.set(folder, [...(groups.get(folder) || []), { file: name, rows: stored, errors, sha, total, pick: true }]);
  }
  if (!groups.size) throw new Error('No CSV batch files found');
  const present = new Set(files.map(relOf));
  return {
    source: list.length === 1 ? list[0].name : `${list.length} files`,
    summary: summary ? dec.decode(summary.bytes) : undefined,
    missing: Array.from(shaOf.keys()).filter((rel) => !present.has(rel)).sort(natural),
    groups: Array.from(groups.entries()).sort(([a], [b]) => natural(a, b)).map(([name, fs]) => ({ name, files: fs.sort((a, b) => natural(a.file, b.file)), pick: true })),
  };
}

#!/usr/bin/env node
import { readFileSync, writeFileSync, mkdirSync, readdirSync, existsSync, statSync, copyFileSync, openSync, readSync, closeSync, type Dirent } from 'node:fs';
import { dirname, basename, extname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { decodeBmsBuffer } from './encoding.js';
import { parseBms } from './parser.js';
import { buildChart, type Chart } from './chart.js';
import { renderChartSvg, type RenderOptions } from './render.js';

/**
 * このスクリプトの位置から親方向に site-dir を自動検出する。
 * `src/_data/tables/` が見つかったディレクトリを採用。
 * tools/texbms/src/cli.ts → tools/texbms/ → tools/ → <site> の順で上る。
 */
function autoDetectSiteDir(): string | null {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 8; i++) {
    if (existsSync(join(dir, 'src/_data/tables'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

interface CliOptions {
  input?: string;
  output?: string;
  pxPerBeat?: number;
  measuresPerColumn?: number;
  showFreeZone?: boolean;
  subdivisions?: number;
  side?: 1 | 2;
  verbose?: boolean;
  json?: string;
  // batch mode
  batchDir?: string;
  siteDir?: string;
  outDir?: string;
  groupId?: string;
  variants?: string;
  registryOut?: string;
  force?: boolean;
  // smart batch
  missingOnly?: boolean;
  libraryIndex?: string;
  audioCache?: string;
  noAudio?: boolean;
}

function parseArgs(argv: string[]): CliOptions {
  const args = argv.slice(2);
  const opts: CliOptions = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '-o' || a === '--output') opts.output = args[++i];
    else if (a === '--px-per-beat') opts.pxPerBeat = Number(args[++i]);
    else if (a === '--measures' || a === '--measures-per-column') opts.measuresPerColumn = Number(args[++i]);
    else if (a === '--subdivisions' || a === '--sub') opts.subdivisions = Number(args[++i]);
    else if (a === '--side') {
      const s = Number(args[++i]);
      opts.side = s === 2 ? 2 : 1;
    }
    else if (a === '--free') opts.showFreeZone = true;
    else if (a === '-v' || a === '--verbose') opts.verbose = true;
    else if (a === '--dump-json') opts.json = args[++i];
    else if (a === '--batch') opts.batchDir = args[++i];
    else if (a === '--site-dir') opts.siteDir = args[++i];
    else if (a === '--out-dir') opts.outDir = args[++i];
    else if (a === '--group-id') opts.groupId = args[++i];
    else if (a === '--variants') opts.variants = args[++i];
    else if (a === '--registry-out') opts.registryOut = args[++i];
    else if (a === '--force') opts.force = true;
    else if (a === '--missing-only') opts.missingOnly = true;
    else if (a === '--library-index') opts.libraryIndex = args[++i];
    else if (a === '--audio-cache') opts.audioCache = args[++i];
    else if (a === '--no-audio') opts.noAudio = true;
    else if (a === '-h' || a === '--help') {
      printHelp();
      process.exit(0);
    } else if (!opts.input) {
      opts.input = a;
    } else {
      console.error(`Unknown argument: ${a}`);
      process.exit(2);
    }
  }
  if (!opts.input && !opts.batchDir) {
    printHelp();
    process.exit(2);
  }
  return opts;
}

function printHelp(): void {
  const usage = `bms2svg - BMS譜面をTeXtage風 静的SVG に変換

Usage:
  bms2svg <input.bms> [options]                # 単一譜面変換
  bms2svg --batch <folder> [options]           # フォルダ一括変換（差分グループ単位）

Single-file options:
  -o, --output <path>          出力 SVG パス (省略時 ./out/<input>.svg)
  --side <1|2>                 SP表示の向き 1=1P側(SC左) / 2=2P側(SC右), default 1
  --dump-json <path>           Chart 中間表現を JSON で書き出し（デバッグ用）

Batch options:
  --batch <folder>             BMSライブラリのルート。再帰的にスキャンする。
                               各譜面ファイルの直接の親フォルダ名 = groupId (差分グループ)
  --site-dir <path>            出力先サイト。指定すると以下が自動設定される:
                                 --out-dir       <site-dir>/src/assets/score
                                 --registry-out  <site-dir>/src/_data/registry.json
  --out-dir <path>             SVG出力先 (default ./out/registry/)
                               配下に {md5}/1p.svg 等を生成
  --group-id <name>            groupIdを上書き (default 譜面の親フォルダ名)
  --variants <list>            生成バリアント (default 1p,2p,1pm,2pm)
                               1p=SC左 / 2p=SC右 / 1pm=1P MIRROR / 2pm=2P MIRROR
  --registry-out <path>        registry JSON 出力パス (default <out-dir>/registry.json)
                               既存ファイルがあればマージ
  --force                      既にregistryに登録済みのmd5も再処理（デフォは skip）

Smart batch (難易度表との差分のみ):
  --missing-only               site-dir のテーブルにあって registry に未登録のmd5だけ処理。
                               テーブルに無いBMS（ライブラリのみ存在 = グレー譜面等）はskip。
                               --site-dir 必須。
  --library-index <path>       BMSライブラリのmd5インデックスファイル
                               (default <batch>/.texbms-index.json)
                               mtime+sizeで変更検知。再実行時は再ハッシュしない。
  --audio-cache <path>         音声ファイルのローカルコピー先
                               (default <batch>/.texbms-audio/)
                               <md5>/ 以下に #WAV 参照ファイルをコピー。サイトには上げない。
  --no-audio                   音声コピーを無効化

Common options:
  --px-per-beat <n>            1ビートあたりピクセル数 (default 32)
  --measures <n>               1列の小節数 (default 4)
  --subdivisions <n>           小節線の細分割
  --free                       フリーゾーン(CH17/27)を表示
  -v, --verbose                詳細ログ
  -h, --help                   ヘルプ

Examples:
  bms2svg samples/test.bme -o out/test.svg
  bms2svg --batch ~/BMSLibrary/song-foo --out-dir ~/site/src/assets/score
`;
  process.stdout.write(usage);
}

function commonRenderOptions(cli: CliOptions): RenderOptions {
  const r: RenderOptions = {};
  if (cli.pxPerBeat) r.pxPerBeat = cli.pxPerBeat;
  if (cli.measuresPerColumn) r.measuresPerColumn = cli.measuresPerColumn;
  if (cli.showFreeZone) r.showFreeZone = true;
  if (cli.subdivisions) r.subdivisions = cli.subdivisions;
  return r;
}

/**
 * BPM変化＋STOPを考慮した曲長（秒）。
 * 各セグメントを (deltaBeats / bpm * 60) で積算し、stop総量を加算する。
 */
function computeDurationSec(chart: Chart): number {
  const events = [...chart.bpmEvents].sort((a, b) => a.beat - b.beat);
  if (events.length === 0 || events[0].beat > 0) {
    events.unshift({ beat: 0, bpm: chart.meta.initialBpm });
  }
  let total = 0;
  for (let i = 0; i < events.length; i++) {
    const ev = events[i];
    const nextBeat = i + 1 < events.length ? events[i + 1].beat : chart.totalBeats;
    const dt = nextBeat - ev.beat;
    if (dt > 0 && ev.bpm > 0) total += (dt / ev.bpm) * 60;
  }
  // STOP量は各STOPの bpm で時間換算
  for (const st of chart.stopEvents) {
    // 直前のbpmを引く
    let bpm = chart.meta.initialBpm;
    for (const ev of events) {
      if (ev.beat <= st.beat) bpm = ev.bpm;
      else break;
    }
    if (bpm > 0) total += (st.durationBeats / bpm) * 60;
  }
  return Math.round(total);
}

/** Note.lane を MIRROR 反転（鍵盤レーン1-7のみ反転、SC/フリーゾーンはそのまま） */
function mirrorChart(chart: Chart): Chart {
  const mirrorIdx = (idx: number) => (idx >= 1 && idx <= 7 ? 8 - idx : idx);
  return {
    ...chart,
    notes: chart.notes.map((n) => ({
      ...n,
      lane: { ...n.lane, index: mirrorIdx(n.lane.index) },
    })),
  };
}

function renderVariant(chart: Chart, variant: string, base: RenderOptions): string {
  const side: 1 | 2 = variant.startsWith('2') ? 2 : 1;
  const mirror = variant.endsWith('m');
  const target = mirror ? mirrorChart(chart) : chart;
  return renderChartSvg(target, { ...base, side });
}

interface RegistryEntry {
  title?: string;
  artist?: string;
  genre?: string;
  bpm?: number | null;
  notes?: number;
  durationSec?: number;
  groupId?: string;
}

/**
 * タイトル末尾の括弧書きを再帰的に剥がして lower-case 化。
 * 表のタイトル "Foo (★5) [ANOTHER]" と BMSファイルの #TITLE "Foo" を揃えるため。
 */
function normalizeTitle(s: string | undefined | null): string {
  if (!s) return '';
  const stripRe = /\s*[\[\(（【［][^\]\)）】］]*[\]\)）】］]\s*$/;
  let t = s.trim();
  let prev: string;
  do {
    prev = t;
    t = t.replace(stripRe, '').trim();
  } while (t !== prev);
  return t.toLowerCase();
}

export interface WantedFromSite {
  md5s: Set<string>;
  /** 正規化タイトル集合。BMS の #TITLE をハッシュ計算前に絞り込むのに使う */
  titles: Set<string>;
}

/**
 * site-dir/src/_data/tables/*.json から md5 集合と正規化タイトル集合を作る。
 * titles はライブラリ走査時の「ハッシュすべきかの判定」に使う whitelist。
 */
function readWantedFromSite(siteDir: string): WantedFromSite {
  const tablesDir = join(siteDir, 'src/_data/tables');
  let names: string[];
  try {
    names = readdirSync(tablesDir).filter((n) => n.endsWith('.json'));
  } catch (e) {
    throw new Error(`tables not found: ${tablesDir} (${e})`);
  }
  const md5s = new Set<string>();
  const titles = new Set<string>();
  for (const name of names) {
    const j = JSON.parse(readFileSync(join(tablesDir, name), 'utf8'));
    const data: unknown = j?.data;
    if (!Array.isArray(data)) continue;
    for (const e of data as Array<Record<string, unknown>>) {
      const md5 = typeof e.md5 === 'string' ? (e.md5 as string).toLowerCase() : '';
      if (md5) md5s.add(md5);
      const title = typeof e.title === 'string' ? (e.title as string) : '';
      const normT = normalizeTitle(title);
      if (normT) titles.add(normT);
    }
  }
  return { md5s, titles };
}

interface IndexEntry {
  mtimeMs: number;
  size: number;
  /** BMSヘッダから抽出した #TITLE (生文字列)。先頭16KBから取れた場合のみ */
  title?: string;
  /** ファイル全体のmd5。title が wanted に該当した場合のみ計算済 */
  md5?: string;
}
type LibraryIndex = Record<string, IndexEntry>;

/** ファイル先頭 N バイトだけ読む。BMS本体は数百KBあるので全読みより速い */
function readFirstBytes(path: string, n: number): Buffer | null {
  let fd: number;
  try {
    fd = openSync(path, 'r');
  } catch {
    return null;
  }
  try {
    const buf = Buffer.alloc(n);
    const read = readSync(fd, buf, 0, n, 0);
    return buf.subarray(0, read);
  } finally {
    closeSync(fd);
  }
}

/** 先頭16KBから #TITLE を抽出 (encoding.ts 経由) */
function peekTitle(path: string): string | null {
  const buf = readFirstBytes(path, 16384);
  if (!buf) return null;
  try {
    const decoded = decodeBmsBuffer(buf);
    const m = decoded.text.match(/^\s*#TITLE\s+(.+)$/im);
    return m ? m[1].trim() : null;
  } catch {
    return null;
  }
}

/**
 * BMSライブラリをインデックス化。`wantedTitles` を渡すと「先頭ヘッダで #TITLE 抽出 → 表のタイトルに該当するファイルだけハッシュ」モードになる。
 * これで 100k規模のライブラリでも実際にハッシュするのは数千件で済む。
 * mtimeMs+size が同じファイルは前回結果を再利用 (title/md5 とも)。
 */
function buildLibraryIndex(
  root: string,
  indexPath: string,
  wantedTitles?: Set<string>,
): { md5ToPath: Map<string, string>; matched: number; hashed: number; titleRead: number; titleReused: number } {
  let prev: LibraryIndex = {};
  if (existsSync(indexPath)) {
    try {
      prev = JSON.parse(readFileSync(indexPath, 'utf8'));
    } catch {
      prev = {};
    }
  }

  const files = listBmsFilesRecursive(root);
  const next: LibraryIndex = {};
  const md5ToPath = new Map<string, string>();
  let titleRead = 0;
  let titleReused = 0;
  let hashed = 0;
  let hashReused = 0;
  let matched = 0;

  const mode = wantedTitles ? 'smart' : 'full';
  console.error(`[index] scanning ${files.length} BMS files in ${root} (mode=${mode})`);
  const reportEvery = Math.max(1, Math.floor(files.length / 20));
  let lastFlush = Date.now();
  const FLUSH_MS = 30_000;

  for (let i = 0; i < files.length; i++) {
    const f = files[i];
    let st;
    try {
      st = statSync(f);
    } catch {
      continue;
    }
    const cached = prev[f];
    const cacheValid =
      cached && cached.mtimeMs === st.mtimeMs && cached.size === st.size;

    // タイトル取得 (キャッシュor先頭読み)
    let title: string | undefined;
    if (cacheValid && cached.title != null) {
      title = cached.title;
      titleReused++;
    } else {
      const t = peekTitle(f);
      if (t != null) title = t;
      titleRead++;
    }

    let md5: string | undefined;
    let needsHash: boolean;
    if (wantedTitles) {
      // smart: title が whitelist に当たればハッシュ、外れたらskip
      needsHash = title != null && wantedTitles.has(normalizeTitle(title));
      // title読めなかった場合は念のためハッシュ(取りこぼし防止)
      if (title == null) needsHash = true;
    } else {
      // full: 全件ハッシュ
      needsHash = true;
    }

    if (needsHash) {
      if (cacheValid && cached.md5) {
        md5 = cached.md5;
        hashReused++;
      } else {
        try {
          const buf = readFileSync(f);
          md5 = createHash('md5').update(new Uint8Array(buf)).digest('hex');
          hashed++;
        } catch (e) {
          console.error(`[index:fail] ${f}: ${e}`);
          continue;
        }
      }
      matched++;
      if (!md5ToPath.has(md5)) md5ToPath.set(md5, f);
    }

    next[f] = { mtimeMs: st.mtimeMs, size: st.size, title, md5 };

    if ((i + 1) % reportEvery === 0) {
      console.error(
        `[index] ${i + 1}/${files.length}  titleRead=${titleRead} titleCache=${titleReused}  hashed=${hashed} hashCache=${hashReused}  matched=${matched}`,
      );
    }
    // 30秒ごとに途中保存(長丁場のクラッシュ耐性)
    if (Date.now() - lastFlush > FLUSH_MS) {
      try {
        mkdirSync(dirname(indexPath), { recursive: true });
        writeFileSync(indexPath, JSON.stringify(next) + '\n');
        lastFlush = Date.now();
      } catch {
        /* keep going */
      }
    }
  }

  // 永続化
  try {
    mkdirSync(dirname(indexPath), { recursive: true });
    writeFileSync(indexPath, JSON.stringify(next) + '\n');
  } catch (e) {
    console.error(`[index:warn] failed to write ${indexPath}: ${e}`);
  }

  console.error(
    `[index] done. matched=${matched}  hashed=${hashed} hashCache=${hashReused}  titleRead=${titleRead} titleCache=${titleReused}`,
  );
  return { md5ToPath, matched, hashed, titleRead, titleReused };
}

/**
 * BMSが参照する音声ファイルを <audioCache>/<md5>/ にコピー。
 * - 既にコピー済みなら skip
 * - 拡張子が違う場合は .ogg/.wav を入れ替えて存在確認
 */
function extractAudioForBms(
  bmsFile: string,
  wavMap: Map<string, string>,
  md5: string,
  audioCache: string,
): { copied: number; skipped: number; missing: number } {
  const bmsDir = dirname(bmsFile);
  const dest = join(audioCache, md5);
  let copied = 0;
  let skipped = 0;
  let missing = 0;

  // 重複ファイル名は1度だけ処理
  const seen = new Set<string>();

  for (const filename of wavMap.values()) {
    if (!filename) continue;
    if (seen.has(filename)) continue;
    seen.add(filename);

    const found = locateAudioFile(bmsDir, filename);
    if (!found) {
      missing++;
      continue;
    }
    const outName = basename(found);
    const outPath = join(dest, outName);
    if (existsSync(outPath)) {
      skipped++;
      continue;
    }
    try {
      mkdirSync(dest, { recursive: true });
      copyFileSync(found, outPath);
      copied++;
    } catch (e) {
      console.error(`[audio:fail] ${found}: ${e}`);
    }
  }
  return { copied, skipped, missing };
}

/** BMSフォルダ内から音声ファイルを探す。指定拡張子→.ogg/.wav入れ替え→大文字小文字無視。 */
function locateAudioFile(dir: string, name: string): string | null {
  const direct = join(dir, name);
  if (existsSync(direct)) return direct;

  // 拡張子swap (.wav ↔ .ogg)
  const ext = extname(name).toLowerCase();
  if (ext === '.wav' || ext === '.ogg') {
    const swap = name.slice(0, -4) + (ext === '.wav' ? '.ogg' : '.wav');
    const swapPath = join(dir, swap);
    if (existsSync(swapPath)) return swapPath;
  }

  // 大文字小文字無視で同名を探す（macOSは無視するがWin/Linuxの混在環境のため）
  try {
    const target = name.toLowerCase();
    const targetBase = target.slice(0, target.length - ext.length);
    for (const ent of readdirSync(dir, { withFileTypes: true })) {
      if (!ent.isFile()) continue;
      const lower = ent.name.toLowerCase();
      if (lower === target) return join(dir, ent.name);
      const lowerExt = extname(lower);
      if ((lowerExt === '.wav' || lowerExt === '.ogg') && lower.slice(0, -4) === targetBase) {
        return join(dir, ent.name);
      }
    }
  } catch {
    /* ignore */
  }
  return null;
}

/** フォルダを再帰的に走査して BMS ファイル全パスを返す */
function listBmsFilesRecursive(root: string): string[] {
  const result: string[] = [];
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop()!;
    let entries: Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true }) as Dirent[];
    } catch {
      continue;
    }
    for (const ent of entries) {
      if (ent.name.startsWith('.')) continue; // .DS_Store 等
      const p = join(dir, ent.name);
      if (ent.isDirectory()) stack.push(p);
      else if (ent.isFile() && /\.(bms|bme|bml|pms)$/i.test(ent.name)) {
        result.push(p);
      }
    }
  }
  return result.sort();
}

async function batchMain(cli: CliOptions) {
  const folder = resolve(cli.batchDir!);

  // --site-dir 指定 or スクリプトの位置から自動検出
  // （3tzamikun/tools/texbms/ 配下にいる前提でリポジトリルートが分かる）
  const siteDir = cli.siteDir
    ? resolve(cli.siteDir)
    : autoDetectSiteDir();
  if (cli.siteDir == null && siteDir) {
    console.error(`[site-dir:auto] ${siteDir}`);
  }
  const outDir = resolve(
    cli.outDir ??
      (siteDir ? join(siteDir, 'src/assets/score') : 'out/registry'),
  );
  const registryPath = resolve(
    cli.registryOut ??
      (siteDir ? join(siteDir, 'src/_data/registry.json') : join(outDir, 'registry.json')),
  );

  const variants = (cli.variants ?? '1p,2p,1pm,2pm').split(',').map((v) => v.trim()).filter(Boolean);
  const validVariants = ['1p', '2p', '1pm', '2pm'];
  for (const v of variants) {
    if (!validVariants.includes(v)) {
      console.error(`Unknown variant: ${v} (valid: ${validVariants.join(',')})`);
      process.exit(2);
    }
  }

  // 既存 registry.json をマージ対象として読む
  let registry: Record<string, RegistryEntry> = {};
  if (existsSync(registryPath)) {
    try {
      registry = JSON.parse(readFileSync(registryPath, 'utf8'));
    } catch (e) {
      console.error(`[warn] failed to parse existing registry, starting fresh: ${e}`);
    }
  }

  // 音声キャッシュ。デフォルトは <library>/.texbms-audio/
  const audioCache =
    !cli.noAudio
      ? resolve(cli.audioCache ?? join(folder, '.texbms-audio'))
      : null;

  // --missing-only: site-dir のテーブルから「不足md5」を計算 → ライブラリindexで該当ファイルだけ処理
  // それ以外: 従来どおり全BMSを走査
  let targets: { file: string; md5: string }[];
  if (cli.missingOnly) {
    if (!siteDir) {
      console.error(
        '[error] --missing-only requires --site-dir (or run from inside the site repo so it can be auto-detected)',
      );
      process.exit(2);
    }
    const wanted = readWantedFromSite(siteDir);
    console.error(
      `[missing-only] wanted=${wanted.md5s.size} md5s / ${wanted.titles.size} titles (from tables in ${siteDir}/src/_data/tables)`,
    );

    const indexPath = resolve(cli.libraryIndex ?? join(folder, '.texbms-index.json'));
    const { md5ToPath } = buildLibraryIndex(folder, indexPath, wanted.titles);

    targets = [];
    let notInLibrary = 0;
    let alreadyRegistered = 0;
    for (const md5 of wanted.md5s) {
      if (!cli.force && registry[md5]) {
        alreadyRegistered++;
        continue;
      }
      const f = md5ToPath.get(md5);
      if (!f) {
        notInLibrary++;
        continue;
      }
      targets.push({ file: f, md5 });
    }
    console.error(
      `[missing-only] todo=${targets.length}  alreadyRegistered=${alreadyRegistered}  notInLibrary=${notInLibrary}`,
    );
    if (targets.length === 0) {
      console.error('[missing-only] nothing to do.');
      return;
    }
  } else {
    const files = listBmsFilesRecursive(folder);
    if (files.length === 0) {
      console.error(`No BMS files in ${folder}`);
      process.exit(2);
    }
    // md5 は処理時に計算（後方互換）
    targets = files.map((f) => ({ file: f, md5: '' }));
  }

  const renderBase = commonRenderOptions(cli);
  let processed = 0;
  let skipped = 0;
  let failed = 0;
  let audioCopied = 0;
  let audioMissing = 0;
  const startedAt = Date.now();
  const total = targets.length;

  console.error(
    `[batch] root=${folder}  total=${total}  out=${outDir}  registry=${registryPath}  variants=${variants.join(',')}  force=${!!cli.force}  audio=${audioCache ?? 'off'}`,
  );

  // 進捗の途中保存用
  let writeCounter = 0;
  const FLUSH_EVERY = 100;

  for (let idx = 0; idx < targets.length; idx++) {
    const { file, md5: knownMd5 } = targets[idx];
    const folderName = basename(dirname(file));
    const groupId = cli.groupId ?? folderName;

    try {
      const buf = readFileSync(file);
      const md5 = knownMd5 || createHash('md5').update(new Uint8Array(buf)).digest('hex');

      // 既登録ならスキップ（--force で強制再処理）
      if (!cli.force && registry[md5]) {
        skipped++;
        if ((idx + 1) % 200 === 0) reportProgress(idx + 1, total, processed, skipped, failed, startedAt);
        continue;
      }

      const decoded = decodeBmsBuffer(buf);
      const parsed = parseBms(decoded.text);
      const chart = buildChart(parsed);
      const noteCount = chart.notes.filter(
        (n) => n.kind === 'normal' || n.kind === 'long'
      ).length;
      const durationSec = computeDurationSec(chart);

      const chartDir = join(outDir, md5);
      mkdirSync(chartDir, { recursive: true });
      for (const v of variants) {
        const svg = renderVariant(chart, v, renderBase);
        writeFileSync(join(chartDir, `${v}.svg`), svg);
      }

      registry[md5] = {
        title: chart.meta.title || undefined,
        artist: chart.meta.artist || undefined,
        genre: chart.meta.genre || undefined,
        bpm: chart.meta.initialBpm || null,
        notes: noteCount,
        durationSec,
        groupId,
      };

      // 音声ファイルをローカルキャッシュにコピー（サイトには上げない）
      if (audioCache) {
        const a = extractAudioForBms(file, parsed.headers.wav, md5, audioCache);
        audioCopied += a.copied;
        audioMissing += a.missing;
        if (cli.verbose) {
          console.error(
            `[audio] ${md5.slice(0, 8)} copied=${a.copied} skip=${a.skipped} missing=${a.missing}`,
          );
        }
      }

      processed++;
      writeCounter++;

      if (cli.verbose) {
        console.error(
          `[ok] ${file} md5=${md5.slice(0, 8)} notes=${noteCount} group=${groupId}`,
        );
      }

      // 100件ごとに途中保存（クラッシュしてもここまでは残る）
      if (writeCounter >= FLUSH_EVERY) {
        mkdirSync(dirname(registryPath), { recursive: true });
        writeFileSync(registryPath, JSON.stringify(registry, null, 2) + '\n');
        writeCounter = 0;
      }

      if ((idx + 1) % 50 === 0) reportProgress(idx + 1, total, processed, skipped, failed, startedAt);
    } catch (e) {
      failed++;
      console.error(`[fail] ${file}: ${e}`);
    }
  }

  // 最終書き出し
  mkdirSync(dirname(registryPath), { recursive: true });
  writeFileSync(registryPath, JSON.stringify(registry, null, 2) + '\n');

  const dur = ((Date.now() - startedAt) / 1000).toFixed(1);
  const audioMsg = audioCache ? `  audioCopied=${audioCopied} audioMissing=${audioMissing}` : '';
  console.error(
    `\n[done] total=${total} processed=${processed} skipped=${skipped} failed=${failed} time=${dur}s${audioMsg} → ${registryPath}`,
  );
}

function reportProgress(
  done: number,
  total: number,
  ok: number,
  skipped: number,
  failed: number,
  startedAt: number,
) {
  const pct = ((done / total) * 100).toFixed(1);
  const dur = (Date.now() - startedAt) / 1000;
  const rate = done / Math.max(dur, 0.001);
  const remaining = (total - done) / Math.max(rate, 0.001);
  console.error(
    `[progress] ${done}/${total} (${pct}%)  ok=${ok} skip=${skipped} fail=${failed}  ${rate.toFixed(1)}f/s  ETA ${remaining.toFixed(0)}s`,
  );
}

async function singleMain(cli: CliOptions) {
  const inputPath = resolve(cli.input!);
  const buf = readFileSync(inputPath);

  const decoded = decodeBmsBuffer(buf);
  if (cli.verbose) {
    console.error(`[encoding] ${decoded.encoding} (confidence ${decoded.confidence.toFixed(2)})`);
  }

  const parsed = parseBms(decoded.text);
  if (cli.verbose) {
    console.error(`[parsed] channels=${parsed.channels.length}`);
    if (parsed.warnings.length) {
      console.error(`[warnings] ${parsed.warnings.length}`);
      for (const w of parsed.warnings.slice(0, 10)) console.error(`  - ${w}`);
    }
  }

  const chart = buildChart(parsed);
  if (cli.verbose) {
    console.error(
      `[chart] notes=${chart.notes.length}  bpmEvents=${chart.bpmEvents.length}  stops=${chart.stopEvents.length}  measures=${chart.barLines.length - 1}`
    );
  }

  if (cli.json) {
    mkdirSync(dirname(cli.json), { recursive: true });
    writeFileSync(cli.json, JSON.stringify(chart, replacer, 2));
    if (cli.verbose) console.error(`[json] -> ${cli.json}`);
  }

  const renderOptions = commonRenderOptions(cli);
  if (cli.side) renderOptions.side = cli.side;

  const svg = renderChartSvg(chart, renderOptions);

  const outputPath = cli.output
    ? resolve(cli.output)
    : resolve('out', `${basename(inputPath, extname(inputPath))}.svg`);
  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, svg);

  console.error(
    `[done] ${inputPath} -> ${outputPath}  (notes=${chart.notes.filter(
      (n) => n.kind === 'normal' || n.kind === 'long'
    ).length})`
  );
}

async function main() {
  const cli = parseArgs(process.argv);
  if (cli.batchDir) await batchMain(cli);
  else await singleMain(cli);
}

function replacer(_key: string, value: unknown) {
  if (value instanceof Map) {
    return Object.fromEntries(value);
  }
  return value;
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

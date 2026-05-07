/**
 * BMS / BME / BML / PMS パーサ
 * 仕様参照: https://hitkey.bms.ms/cmds.htm
 *
 * 設計方針:
 *   1. テキストを1行ずつ走査
 *   2. ヘッダ行とチャネル行を別管理で蓄積（生データに近い形）
 *   3. RANDOM/SWITCH 制御は最小限の対応（最初のIFブロックのみ展開）
 *   4. 後段(chart.ts)で絶対ビート座標へ正規化
 */

export type IndexedMap<V> = Map<string, V>;

export interface RawHeaders {
  player: number;
  genre: string;
  title: string;
  subtitle: string;
  artist: string;
  subartist: string;
  maker: string;
  comment: string[];
  bpm: number;
  playLevel: number | null;
  rank: number;
  defExRank: number | null;
  total: number | null;
  difficulty: number | null;
  stageFile: string;
  banner: string;
  backBmp: string;
  lnType: 1 | 2;
  lnObj: string | null;
  lnMode: number | null;
  volWav: number | null;
  charset: string | null;
  /** xx -> filename */
  wav: IndexedMap<string>;
  bmp: IndexedMap<string>;
  /** xx -> bpm value */
  bpmDef: IndexedMap<number>;
  /** xx -> stop length (1/192小節単位) */
  stopDef: IndexedMap<number>;
  /** xx -> scroll multiplier (beatoraja拡張) */
  scrollDef: IndexedMap<number>;
  /** xx -> speed multiplier */
  speedDef: IndexedMap<number>;
}

export interface RawChannelLine {
  measure: number;
  channel: string; // 例 "11", "16", "D1", "08"
  data: string;    // 元の生文字列
}

export interface ParseResult {
  headers: RawHeaders;
  channels: RawChannelLine[];
  warnings: string[];
}

const BASE36 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';

export function parseBase36(s: string): number {
  if (!s) return 0;
  const upper = s.toUpperCase();
  let v = 0;
  for (let i = 0; i < upper.length; i++) {
    const idx = BASE36.indexOf(upper[i]);
    if (idx < 0) return NaN;
    v = v * 36 + idx;
  }
  return v;
}

function emptyHeaders(): RawHeaders {
  return {
    player: 1,
    genre: '',
    title: '',
    subtitle: '',
    artist: '',
    subartist: '',
    maker: '',
    comment: [],
    bpm: 130,
    playLevel: null,
    rank: 2,
    defExRank: null,
    total: null,
    difficulty: null,
    stageFile: '',
    banner: '',
    backBmp: '',
    lnType: 1,
    lnObj: null,
    lnMode: null,
    volWav: null,
    charset: null,
    wav: new Map(),
    bmp: new Map(),
    bpmDef: new Map(),
    stopDef: new Map(),
    scrollDef: new Map(),
    speedDef: new Map(),
  };
}

const CHANNEL_LINE_RE = /^#(\d{3})([0-9A-Z]{2}):(.*)$/i;
const INDEXED_HEADER_RE = /^#([A-Z]+)([0-9A-Z]{2})\s+(.+)$/i;
const PLAIN_HEADER_RE = /^#([A-Z][A-Z0-9_/]*)(?:\s+(.+))?$/i;

export function parseBms(text: string): ParseResult {
  const warnings: string[] = [];
  const headers = emptyHeaders();
  const channels: RawChannelLine[] = [];

  const lines = text.replace(/\r\n?/g, '\n').split('\n');

  /** RANDOM/IF 制御の最小実装: トップレベルのみ。IF 1 を採用 */
  let randomDepth = 0;
  let randomTaken: boolean[] = []; // 各深さで「IF を取ったか」
  let randomActive: boolean[] = []; // 各深さで「現在ブロックを採用中か」
  const isActive = () => randomActive.every(Boolean);

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;
    if (!line.startsWith('#')) continue;

    const upperHead = line.split(/\s+/, 1)[0].toUpperCase();

    // 制御構文
    if (upperHead === '#RANDOM' || upperHead === '#SETRANDOM') {
      randomDepth++;
      randomTaken.push(false);
      randomActive.push(true);
      continue;
    }
    if (upperHead === '#IF') {
      const arg = line.split(/\s+/)[1];
      const depth = randomDepth - 1;
      if (depth < 0) {
        warnings.push(`#IF outside #RANDOM: ${line}`);
        continue;
      }
      // 最初に出てきた #IF だけ採用
      const take = !randomTaken[depth] && (arg === '1' || randomDepth === 1);
      if (take) randomTaken[depth] = true;
      randomActive[depth] = take;
      continue;
    }
    if (upperHead === '#ELSEIF' || upperHead === '#ELSE') {
      const depth = randomDepth - 1;
      if (depth < 0) continue;
      const take = !randomTaken[depth];
      if (take) randomTaken[depth] = true;
      randomActive[depth] = take;
      continue;
    }
    if (upperHead === '#ENDIF') {
      const depth = randomDepth - 1;
      if (depth < 0) continue;
      randomActive[depth] = true;
      continue;
    }
    if (upperHead === '#ENDRANDOM') {
      randomDepth = Math.max(0, randomDepth - 1);
      randomTaken.pop();
      randomActive.pop();
      continue;
    }

    if (!isActive()) continue;

    // チャネル行
    const chMatch = CHANNEL_LINE_RE.exec(line);
    if (chMatch) {
      const measure = parseInt(chMatch[1], 10);
      const channel = chMatch[2].toUpperCase();
      const data = chMatch[3].trim();
      channels.push({ measure, channel, data });
      continue;
    }

    // ヘッダ行: インデックス付き
    const idxMatch = INDEXED_HEADER_RE.exec(line);
    if (idxMatch) {
      const key = idxMatch[1].toUpperCase();
      const idx = idxMatch[2].toUpperCase();
      const val = idxMatch[3].trim();
      if (assignIndexed(headers, key, idx, val)) continue;
      // インデックスっぽく見えても実は通常ヘッダの場合（例: #PLAYLEVEL 12）
      // ↓のフォールバックに任せる
    }

    // ヘッダ行: 通常
    const hMatch = PLAIN_HEADER_RE.exec(line);
    if (hMatch) {
      const key = hMatch[1].toUpperCase();
      const val = (hMatch[2] ?? '').trim();
      assignPlain(headers, key, val, warnings);
      continue;
    }

    // 一致しない場合は無視（コメント扱い）
  }

  return { headers, channels, warnings };
}

function assignIndexed(h: RawHeaders, key: string, idx: string, val: string): boolean {
  switch (key) {
    case 'WAV':
      h.wav.set(idx, val);
      return true;
    case 'BMP':
      h.bmp.set(idx, val);
      return true;
    case 'BPM': {
      const n = Number(val);
      if (!Number.isNaN(n)) h.bpmDef.set(idx, n);
      return true;
    }
    case 'EXBPM': {
      const n = Number(val);
      if (!Number.isNaN(n)) h.bpmDef.set(idx, n);
      return true;
    }
    case 'STOP': {
      const n = Number(val);
      if (!Number.isNaN(n)) h.stopDef.set(idx, n);
      return true;
    }
    case 'SCROLL': {
      const n = Number(val);
      if (!Number.isNaN(n)) h.scrollDef.set(idx, n);
      return true;
    }
    case 'SPEED': {
      const n = Number(val);
      if (!Number.isNaN(n)) h.speedDef.set(idx, n);
      return true;
    }
    default:
      return false;
  }
}

function assignPlain(h: RawHeaders, key: string, val: string, warnings: string[]): void {
  switch (key) {
    case 'PLAYER':
      h.player = parseInt(val, 10) || 1;
      break;
    case 'GENRE':
      h.genre = val;
      break;
    case 'TITLE':
      h.title = val;
      break;
    case 'SUBTITLE':
      h.subtitle = h.subtitle ? `${h.subtitle} ${val}` : val;
      break;
    case 'ARTIST':
      h.artist = val;
      break;
    case 'SUBARTIST':
      h.subartist = h.subartist ? `${h.subartist} / ${val}` : val;
      break;
    case 'MAKER':
      h.maker = val;
      break;
    case 'COMMENT':
      h.comment.push(val.replace(/^"|"$/g, ''));
      break;
    case 'BPM': {
      const n = Number(val);
      if (!Number.isNaN(n) && n > 0) h.bpm = n;
      break;
    }
    case 'PLAYLEVEL':
      h.playLevel = parseInt(val, 10);
      if (Number.isNaN(h.playLevel)) h.playLevel = null;
      break;
    case 'RANK':
      h.rank = parseInt(val, 10);
      if (Number.isNaN(h.rank)) h.rank = 2;
      break;
    case 'DEFEXRANK':
      h.defExRank = Number(val);
      if (Number.isNaN(h.defExRank)) h.defExRank = null;
      break;
    case 'TOTAL':
      h.total = Number(val);
      if (Number.isNaN(h.total)) h.total = null;
      break;
    case 'DIFFICULTY':
      h.difficulty = parseInt(val, 10);
      if (Number.isNaN(h.difficulty)) h.difficulty = null;
      break;
    case 'STAGEFILE':
      h.stageFile = val;
      break;
    case 'BANNER':
      h.banner = val;
      break;
    case 'BACKBMP':
      h.backBmp = val;
      break;
    case 'LNTYPE':
      h.lnType = parseInt(val, 10) === 2 ? 2 : 1;
      break;
    case 'LNOBJ':
      h.lnObj = val.toUpperCase();
      break;
    case 'LNMODE':
      h.lnMode = parseInt(val, 10);
      break;
    case 'VOLWAV':
      h.volWav = parseInt(val, 10);
      break;
    case 'CHARSET':
      h.charset = val;
      break;
    default:
      // 未対応のヘッダは黙って無視（warning に積むだけ）
      warnings.push(`Unhandled header: #${key}`);
  }
}

/**
 * チャネルデータ "11221F00..." を [{posInMeasure: 0..1, value: '11'}, ...] に分解
 * value === '00' は休符として除外
 */
export function splitChannelData(data: string): { pos: number; value: string }[] {
  const trimmed = data.replace(/\s+/g, '');
  if (trimmed.length === 0) return [];
  // 奇数桁ならゼロ埋め（パーサ寛容性）
  const padded = trimmed.length % 2 === 0 ? trimmed : trimmed + '0';
  const count = padded.length / 2;
  const result: { pos: number; value: string }[] = [];
  for (let i = 0; i < count; i++) {
    const v = padded.slice(i * 2, i * 2 + 2).toUpperCase();
    if (v === '00') continue;
    result.push({ pos: i / count, value: v });
  }
  return result;
}

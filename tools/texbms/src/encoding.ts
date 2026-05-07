import iconv from 'iconv-lite';
import jschardet from 'jschardet';

export interface DecodeResult {
  text: string;
  encoding: string;
  confidence: number;
}

const SHIFT_JIS_ALIASES = new Set([
  'shift_jis',
  'shift-jis',
  'sjis',
  'cp932',
  'windows-31j',
  'ms932',
]);

function normalizeEncoding(label: string | undefined | null): string {
  if (!label) return 'shift_jis';
  const k = label.toLowerCase().replace(/_/g, '-');
  if (SHIFT_JIS_ALIASES.has(k)) return 'shift_jis';
  if (k === 'utf-8' || k === 'utf8') return 'utf8';
  if (k === 'euc-jp' || k === 'eucjp') return 'euc-jp';
  if (k === 'utf-16' || k === 'utf-16le' || k === 'utf-16be') return k;
  if (k === 'ascii') return 'shift_jis';
  return 'shift_jis';
}

function stripBom(buf: Buffer): { buf: Buffer; encoding: string | null } {
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
    return { buf: buf.subarray(3), encoding: 'utf8' };
  }
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) {
    return { buf: buf.subarray(2), encoding: 'utf-16le' };
  }
  if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) {
    return { buf: buf.subarray(2), encoding: 'utf-16be' };
  }
  return { buf, encoding: null };
}

function findCharsetCommand(buf: Buffer): string | null {
  const head = buf.subarray(0, Math.min(buf.length, 4096)).toString('latin1');
  const m = head.match(/#CHARSET\s+([^\s\r\n]+)/i);
  return m ? normalizeEncoding(m[1]) : null;
}

export function decodeBmsBuffer(buf: Buffer): DecodeResult {
  const { buf: stripped, encoding: bom } = stripBom(buf);
  if (bom) {
    return { text: iconv.decode(stripped, bom), encoding: bom, confidence: 1 };
  }

  const declared = findCharsetCommand(stripped);
  if (declared) {
    return {
      text: iconv.decode(stripped, declared),
      encoding: declared,
      confidence: 0.95,
    };
  }

  if (looksLikeValidUtf8(stripped)) {
    return { text: iconv.decode(stripped, 'utf8'), encoding: 'utf8', confidence: 0.9 };
  }

  const detected = jschardet.detect(stripped);
  const enc = normalizeEncoding(detected?.encoding ?? null);
  return {
    text: iconv.decode(stripped, enc),
    encoding: enc,
    confidence: detected?.confidence ?? 0.5,
  };
}

function looksLikeValidUtf8(buf: Buffer): boolean {
  let hasMultibyte = false;
  let i = 0;
  while (i < buf.length) {
    const b = buf[i];
    if (b < 0x80) {
      i += 1;
      continue;
    }
    hasMultibyte = true;
    let len: number;
    if ((b & 0xe0) === 0xc0) len = 2;
    else if ((b & 0xf0) === 0xe0) len = 3;
    else if ((b & 0xf8) === 0xf0) len = 4;
    else return false;
    if (i + len > buf.length) return false;
    for (let j = 1; j < len; j++) {
      if ((buf[i + j] & 0xc0) !== 0x80) return false;
    }
    i += len;
  }
  return hasMultibyte;
}

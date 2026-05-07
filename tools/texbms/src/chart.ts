/**
 * BMS チャネル/ヘッダの生データを「絶対ビート座標を持つ譜面」に正規化する
 *
 * ビート座標系:
 *   1拍 = 1.0 (4/4 標準小節は 4.0 ビート)
 *   #xxx02 で小節長 r が指定されると、その小節は 4 * r ビート
 */

import type { ParseResult, RawChannelLine } from './parser.js';
import { parseBase36, splitChannelData } from './parser.js';

export type LaneType = 'key' | 'scratch' | 'free';

export interface Lane {
  side: 1 | 2;
  index: number; // 0=SC, 1..7=K1..K7, 8=フリーゾーン
  type: LaneType;
}

export type NoteKind = 'normal' | 'long' | 'mine' | 'invisible';

export interface Note {
  beat: number;
  lane: Lane;
  kind: NoteKind;
  endBeat?: number; // LN 用
  wav?: string;
}

export interface BpmEvent {
  beat: number;
  bpm: number;
}

export interface StopEvent {
  beat: number;
  /** 停止する長さ（ビート単位）*/
  durationBeats: number;
}

export interface BarLine {
  beat: number;
  measure: number; // 1始まり
  /** 拍子比率（4/4=1.0） */
  ratio: number;
}

export interface ChartMeta {
  title: string;
  subtitle: string;
  artist: string;
  subartist: string;
  genre: string;
  initialBpm: number;
  playLevel: number | null;
  difficulty: number | null;
  rank: number;
  total: number | null;
  player: number;
  /** 譜面が DP かどうか */
  isDP: boolean;
}

export interface Chart {
  meta: ChartMeta;
  notes: Note[];
  bpmEvents: BpmEvent[];
  stopEvents: StopEvent[];
  barLines: BarLine[];
  totalBeats: number;
  warnings: string[];
}

/* ---------------- レーンマッピング ---------------- */

interface LaneMapEntry {
  visible: string;   // 可視ノートCH
  invisible: string; // 不可視ノートCH
  ln: string;        // LNチャネル
  mine: string;      // 地雷チャネル
  lane: Lane;
}

function makeLaneMap(): Map<string, LaneMapEntry> {
  const entries: LaneMapEntry[] = [];
  // 1P
  const p1: Array<[string, string, string, string, Lane]> = [
    ['11', '31', '51', 'D1', { side: 1, index: 1, type: 'key' }],
    ['12', '32', '52', 'D2', { side: 1, index: 2, type: 'key' }],
    ['13', '33', '53', 'D3', { side: 1, index: 3, type: 'key' }],
    ['14', '34', '54', 'D4', { side: 1, index: 4, type: 'key' }],
    ['15', '35', '55', 'D5', { side: 1, index: 5, type: 'key' }],
    ['18', '38', '58', 'D8', { side: 1, index: 6, type: 'key' }],
    ['19', '39', '59', 'D9', { side: 1, index: 7, type: 'key' }],
    ['16', '36', '56', 'D6', { side: 1, index: 0, type: 'scratch' }],
    ['17', '37', '57', 'D7', { side: 1, index: 8, type: 'free' }],
  ];
  // 2P
  const p2: Array<[string, string, string, string, Lane]> = [
    ['21', '41', '61', 'E1', { side: 2, index: 1, type: 'key' }],
    ['22', '42', '62', 'E2', { side: 2, index: 2, type: 'key' }],
    ['23', '43', '63', 'E3', { side: 2, index: 3, type: 'key' }],
    ['24', '44', '64', 'E4', { side: 2, index: 4, type: 'key' }],
    ['25', '45', '65', 'E5', { side: 2, index: 5, type: 'key' }],
    ['28', '48', '68', 'E8', { side: 2, index: 6, type: 'key' }],
    ['29', '49', '69', 'E9', { side: 2, index: 7, type: 'key' }],
    ['26', '46', '66', 'E6', { side: 2, index: 0, type: 'scratch' }],
    ['27', '47', '67', 'E7', { side: 2, index: 8, type: 'free' }],
  ];
  for (const [v, inv, ln, mine, lane] of [...p1, ...p2]) {
    entries.push({ visible: v, invisible: inv, ln, mine, lane });
  }

  const map = new Map<string, LaneMapEntry>();
  for (const e of entries) {
    map.set(e.visible, e);
    map.set(e.invisible, { ...e, visible: e.invisible });
    map.set(e.ln, { ...e, visible: e.ln });
    map.set(e.mine, { ...e, visible: e.mine });
  }
  return map;
}

function getLaneByChannel(
  ch: string,
  map: Map<string, LaneMapEntry>
): { lane: Lane; kind: 'visible' | 'invisible' | 'ln' | 'mine' } | null {
  const e = map.get(ch);
  if (!e) return null;
  if (['11','12','13','14','15','16','17','18','19','21','22','23','24','25','26','27','28','29'].includes(ch)) {
    return { lane: e.lane, kind: 'visible' };
  }
  if (ch.startsWith('3') || ch.startsWith('4')) {
    return { lane: e.lane, kind: 'invisible' };
  }
  if (ch.startsWith('5') || ch.startsWith('6')) {
    return { lane: e.lane, kind: 'ln' };
  }
  if (ch.startsWith('D') || ch.startsWith('E')) {
    return { lane: e.lane, kind: 'mine' };
  }
  return null;
}

/* ---------------- 正規化本体 ---------------- */

export function buildChart(parsed: ParseResult): Chart {
  const { headers, channels } = parsed;
  const warnings = [...parsed.warnings];
  const laneMap = makeLaneMap();

  // 小節長（拍子）を集計。デフォルト1.0
  const measureRatios: Map<number, number> = new Map();
  let maxMeasure = 0;
  for (const c of channels) {
    if (c.measure > maxMeasure) maxMeasure = c.measure;
  }
  for (const c of channels) {
    if (c.channel === '02') {
      const ratio = parseFloat(c.data);
      if (!Number.isNaN(ratio) && ratio > 0) {
        measureRatios.set(c.measure, ratio);
      }
    }
  }

  // 各小節の開始ビート（前の小節の長さを累積）
  const barLines: BarLine[] = [];
  const measureStartBeat: number[] = [];
  let acc = 0;
  for (let m = 0; m <= maxMeasure + 1; m++) {
    measureStartBeat[m] = acc;
    const ratio = measureRatios.get(m) ?? 1.0;
    barLines.push({ beat: acc, measure: m + 1, ratio });
    acc += 4 * ratio;
  }
  const totalBeats = acc;

  // BPM 変化
  const bpmEvents: BpmEvent[] = [];
  bpmEvents.push({ beat: 0, bpm: headers.bpm });

  // STOP 変化
  const stopEvents: StopEvent[] = [];

  // ノート
  const notes: Note[] = [];

  // LN 開始保留: side+index ごとに「直前にぶつかった LN 開始ノート」を覚えておく
  // LNTYPE 1: 51-69 のデータでペアにする
  // LNTYPE 2: 同インデックスが連続している間 = LN
  // LNOBJ: 通常チャネルで lnObj 値が出たら、直前の同レーンの normal ノートを LN に書き換え
  const lnPending: Map<string, number> = new Map(); // laneKey -> noteIndex

  function laneKey(lane: Lane): string {
    return `${lane.side}-${lane.index}-${lane.type}`;
  }

  function beatInMeasure(measure: number, posInMeasure: number): number {
    const ratio = measureRatios.get(measure) ?? 1.0;
    return measureStartBeat[measure] + posInMeasure * 4 * ratio;
  }

  // チャネルを (measure, channel) で安定ソート
  const sorted: RawChannelLine[] = [...channels].sort((a, b) => {
    if (a.measure !== b.measure) return a.measure - b.measure;
    return a.channel.localeCompare(b.channel);
  });

  for (const c of sorted) {
    const ch = c.channel;
    if (ch === '02') continue; // 拍子は処理済

    if (ch === '01') {
      // BGM はノート扱いせず無視（描画対象外）
      continue;
    }

    if (ch === '03') {
      // 直値BPM (16進数)
      const events = splitChannelData(c.data);
      for (const ev of events) {
        const bpm = parseInt(ev.value, 16);
        if (bpm > 0) bpmEvents.push({ beat: beatInMeasure(c.measure, ev.pos), bpm });
      }
      continue;
    }

    if (ch === '08') {
      // 拡張BPM参照
      const events = splitChannelData(c.data);
      for (const ev of events) {
        const bpm = headers.bpmDef.get(ev.value);
        if (bpm !== undefined && bpm > 0) {
          bpmEvents.push({ beat: beatInMeasure(c.measure, ev.pos), bpm });
        }
      }
      continue;
    }

    if (ch === '09') {
      // STOP
      const events = splitChannelData(c.data);
      for (const ev of events) {
        const stopUnits = headers.stopDef.get(ev.value);
        if (stopUnits !== undefined && stopUnits > 0) {
          // 1単位 = 1/192 小節 = 4/192 = 1/48 ビート
          const durationBeats = stopUnits / 48;
          stopEvents.push({ beat: beatInMeasure(c.measure, ev.pos), durationBeats });
        }
      }
      continue;
    }

    // BGA系は今は無視（04/06/07）
    if (ch === '04' || ch === '06' || ch === '07' || ch === '0A') continue;

    // ノート系チャネル
    const laneInfo = getLaneByChannel(ch, laneMap);
    if (!laneInfo) {
      // 未対応チャネル
      continue;
    }

    const events = splitChannelData(c.data);
    for (const ev of events) {
      const beat = beatInMeasure(c.measure, ev.pos);

      if (laneInfo.kind === 'mine') {
        notes.push({
          beat,
          lane: laneInfo.lane,
          kind: 'mine',
        });
        continue;
      }

      if (laneInfo.kind === 'invisible') {
        notes.push({
          beat,
          lane: laneInfo.lane,
          kind: 'invisible',
          wav: headers.wav.get(ev.value),
        });
        continue;
      }

      if (laneInfo.kind === 'ln') {
        // LN チャネル: 51-69
        const k = laneKey(laneInfo.lane);
        if (headers.lnType === 2) {
          // MGQ: 同じ値が続いてる間 LN。このイベント点に「ノート開始」を入れる
          // 簡略化: 連続区間の最初と最後でペアを作るため、別パスで処理する
          const note: Note = {
            beat,
            lane: laneInfo.lane,
            kind: 'long',
            wav: headers.wav.get(ev.value),
          };
          (note as any).__mgqMark = ev.value;
          notes.push(note);
        } else {
          // RDM: ペアで開始/終了
          const pendingIdx = lnPending.get(k);
          if (pendingIdx === undefined) {
            const note: Note = {
              beat,
              lane: laneInfo.lane,
              kind: 'long',
              wav: headers.wav.get(ev.value),
            };
            notes.push(note);
            lnPending.set(k, notes.length - 1);
          } else {
            const start = notes[pendingIdx];
            start.endBeat = beat;
            lnPending.delete(k);
          }
        }
        continue;
      }

      // visible: 通常ノート
      // LNOBJ 終端なら、直前の同レーンノートを LN に伸ばす
      if (headers.lnObj && ev.value === headers.lnObj) {
        const k = laneKey(laneInfo.lane);
        const startIdx = lnPending.get(k);
        if (startIdx !== undefined) {
          const start = notes[startIdx];
          if (start.kind !== 'mine' && start.kind !== 'invisible') {
            start.kind = 'long';
            start.endBeat = beat;
          }
          lnPending.delete(k);
        }
        continue;
      }

      const note: Note = {
        beat,
        lane: laneInfo.lane,
        kind: 'normal',
        wav: headers.wav.get(ev.value),
      };
      notes.push(note);

      // LNOBJ 用に直前ノートを覚えておく
      if (headers.lnObj) {
        lnPending.set(laneKey(laneInfo.lane), notes.length - 1);
      }
    }
  }

  // LNTYPE 2 の MGQ 後処理: 同レーンで連続する long ノートをまとめる
  if (headers.lnType === 2) {
    const byLane = new Map<string, Note[]>();
    for (const n of notes) {
      if (n.kind !== 'long') continue;
      const k = laneKey(n.lane);
      if (!byLane.has(k)) byLane.set(k, []);
      byLane.get(k)!.push(n);
    }
    for (const arr of byLane.values()) {
      arr.sort((a, b) => a.beat - b.beat);
      // 連続区間の最初を残し、間と終端は削除フラグ
      const toRemove = new Set<Note>();
      for (let i = 0; i < arr.length;) {
        const start = arr[i];
        let j = i;
        while (j + 1 < arr.length) {
          j++;
        }
        // MGQの厳密判定は省略: 連続するlongは最初->最後を一区間とみなす
        const end = arr[j];
        if (end !== start) {
          start.endBeat = end.beat;
          for (let k = i + 1; k <= j; k++) toRemove.add(arr[k]);
        }
        i = j + 1;
      }
      // 削除
      for (let i = notes.length - 1; i >= 0; i--) {
        if (toRemove.has(notes[i])) notes.splice(i, 1);
      }
    }
  }

  // 残った lnPending を未閉じ判定するのは LNTYPE 1 のときだけ（51-69 ペア記法）
  // LNOBJ 使用時の pending は「次に LNOBJ が来たら LN 化する候補」なので未閉じではない
  if (lnPending.size > 0 && headers.lnType === 1 && !headers.lnObj) {
    warnings.push(`Unclosed LNs: ${lnPending.size}`);
  }

  // BPM/STOP/notes をビート順にソート
  bpmEvents.sort((a, b) => a.beat - b.beat);
  stopEvents.sort((a, b) => a.beat - b.beat);
  notes.sort((a, b) => a.beat - b.beat);

  // BPM 値が変化していないイベントは描画しない（直前と同じBPMはスキップ）
  const dedupedBpm: BpmEvent[] = [];
  for (const ev of bpmEvents) {
    const last = dedupedBpm[dedupedBpm.length - 1];
    if (last && Math.abs(last.bpm - ev.bpm) < 1e-9) continue;
    dedupedBpm.push(ev);
  }
  bpmEvents.length = 0;
  bpmEvents.push(...dedupedBpm);

  const meta: ChartMeta = {
    title: headers.title,
    subtitle: headers.subtitle,
    artist: headers.artist,
    subartist: headers.subartist,
    genre: headers.genre,
    initialBpm: headers.bpm,
    playLevel: headers.playLevel,
    difficulty: headers.difficulty,
    rank: headers.rank,
    total: headers.total,
    player: headers.player,
    isDP: headers.player === 3,
  };

  return {
    meta,
    notes,
    bpmEvents,
    stopEvents,
    barLines,
    totalBeats,
    warnings,
  };
}

// dev用エクスポート
export { parseBase36 };

/**
 * Chart -> SVG レンダラ（TeXtage インスパイア・横並び型）
 *
 * レイアウト思想:
 *   - 列(Column)は 4小節分。下が時間的に先、上が後（IIDX 流）
 *   - 列は左から右に並ぶ
 *   - レーン: SC, K1..K7（DPの場合 1P/2P を並べる）
 *   - 拍子変化小節は物理ビート数に応じて高さが変わる（列ごとに高さが揃わなくてOK）
 *   - BPM変化: 緑のラインに数値ラベル
 */

import type { Chart, Lane, Note } from './chart.js';

export interface RenderOptions {
  pxPerBeat?: number;
  measuresPerColumn?: number;
  laneKeyWidth?: number;
  laneScratchWidth?: number;
  columnGap?: number;
  marginLeft?: number;
  marginRight?: number;
  marginTop?: number;
  marginBottom?: number;
  headerHeight?: number;
  background?: string;
  showFreeZone?: boolean;
  /** 1ピクセル未満の細かなノートをまとめて見やすくする最小高さ */
  minNoteHeight?: number;
  /** 列の上下に追加する余白（小節番号の余裕） */
  columnPadding?: number;
  /** 1拍を何分割まで罫線で見せるか。4=4分(拍のみ) / 8=8分 / 16=16分 / 24=三連符 / 32=32分 */
  subdivisions?: number;
  /** SP表示の向き。1=1P側(SC左), 2=2P側(SC右)。DPでは無視 */
  side?: 1 | 2;
}

const DEFAULTS: Required<RenderOptions> = {
  pxPerBeat: 56,
  measuresPerColumn: 4,
  laneKeyWidth: 20,
  laneScratchWidth: 30,
  columnGap: 36,
  marginLeft: 24,
  marginRight: 24,
  marginTop: 16,
  marginBottom: 24,
  headerHeight: 96,
  background: '#0e1018',
  showFreeZone: false,
  minNoteHeight: 3,
  columnPadding: 10,
  subdivisions: 16,
  side: 1,
};

/* ---------------- レーン色 ---------------- */

interface LaneStyle {
  fill: string;
  stroke: string;
  long: string;
  longStroke: string;
}

const LANE_STYLE_KEY_WHITE: LaneStyle = {
  fill: '#f4f4f6',
  stroke: '#1d2030',
  long: '#dadbe6',
  longStroke: '#3a3d52',
};
const LANE_STYLE_KEY_BLUE: LaneStyle = {
  fill: '#5b9ad9',
  stroke: '#0e2944',
  long: '#3d6e9c',
  longStroke: '#0e2944',
};
const LANE_STYLE_SCRATCH: LaneStyle = {
  fill: '#d24f48',
  stroke: '#3b0f0c',
  long: '#9c3631',
  longStroke: '#3b0f0c',
};
const LANE_STYLE_FREE: LaneStyle = {
  fill: '#888',
  stroke: '#222',
  long: '#5d5d5d',
  longStroke: '#222',
};

function laneStyle(lane: Lane): LaneStyle {
  if (lane.type === 'scratch') return LANE_STYLE_SCRATCH;
  if (lane.type === 'free') return LANE_STYLE_FREE;
  // 1,3,5,7 = 白鍵, 2,4,6 = 黒鍵（IIDX流）
  if (lane.index === 2 || lane.index === 4 || lane.index === 6) return LANE_STYLE_KEY_BLUE;
  return LANE_STYLE_KEY_WHITE;
}

/* ---------------- レーン並び ---------------- */

interface LaneSlot {
  lane: Lane;
  width: number;
  /** 列内左端からのオフセット */
  x: number;
}

function buildLaneSlots(
  isDP: boolean,
  opts: Required<RenderOptions>
): { slots: LaneSlot[]; columnWidth: number } {
  // IIDX 配列: SC, K1, K2, K3, K4, K5, K6, K7
  const lanes: Lane[] = [];

  if (isDP) {
    // DP: 1P (SC左) | 2P (SC右)
    lanes.push({ side: 1, index: 0, type: 'scratch' });
    for (let i = 1; i <= 7; i++) lanes.push({ side: 1, index: i, type: 'key' });
    if (opts.showFreeZone) lanes.push({ side: 1, index: 8, type: 'free' });
    if (opts.showFreeZone) lanes.push({ side: 2, index: 8, type: 'free' });
    for (let i = 7; i >= 1; i--) lanes.push({ side: 2, index: i, type: 'key' });
    lanes.push({ side: 2, index: 0, type: 'scratch' });
  } else if (opts.side === 2) {
    // SP 2P側表示: K1..K7 | SC（SC右）
    for (let i = 1; i <= 7; i++) lanes.push({ side: 1, index: i, type: 'key' });
    if (opts.showFreeZone) lanes.push({ side: 1, index: 8, type: 'free' });
    lanes.push({ side: 1, index: 0, type: 'scratch' });
  } else {
    // SP 1P側表示: SC | K1..K7（SC左）
    lanes.push({ side: 1, index: 0, type: 'scratch' });
    for (let i = 1; i <= 7; i++) lanes.push({ side: 1, index: i, type: 'key' });
    if (opts.showFreeZone) lanes.push({ side: 1, index: 8, type: 'free' });
  }

  const slots: LaneSlot[] = [];
  let x = 0;
  for (const lane of lanes) {
    const width = lane.type === 'scratch' ? opts.laneScratchWidth : opts.laneKeyWidth;
    slots.push({ lane, width, x });
    x += width;
  }
  return { slots, columnWidth: x };
}

/**
 * 与えた lane に該当するスロット **すべて** を返す。
 * SP表示の左右SCのように同一レーンが複数スロットを持つケースに対応。
 */
function laneSlots(slots: LaneSlot[], lane: Lane): LaneSlot[] {
  const out: LaneSlot[] = [];
  for (const s of slots) {
    if (s.lane.side === lane.side && s.lane.index === lane.index && s.lane.type === lane.type) {
      out.push(s);
    }
  }
  return out;
}

/* ---------------- SVG ヘルパ ---------------- */

function escapeXml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function fmt(n: number): string {
  // 小数点 3 桁まで
  return Number.isInteger(n) ? String(n) : n.toFixed(3).replace(/\.?0+$/, '');
}

/* ---------------- レンダリング ---------------- */

export function renderChartSvg(chart: Chart, options: RenderOptions = {}): string {
  const opts = { ...DEFAULTS, ...options } as Required<RenderOptions>;
  const { slots, columnWidth } = buildLaneSlots(chart.meta.isDP, opts);

  // 列分割: 各列は 4小節
  const measureCount = chart.barLines.length - 1; // 最後はsentinel
  const totalColumns = Math.max(1, Math.ceil(measureCount / opts.measuresPerColumn));

  // 各列の (startMeasure, endMeasure, beats, height) を計算
  interface ColumnInfo {
    startMeasure: number;
    endMeasure: number;
    startBeat: number;
    endBeat: number;
    beats: number;
    height: number;
  }
  const columns: ColumnInfo[] = [];
  for (let c = 0; c < totalColumns; c++) {
    const startMeasure = c * opts.measuresPerColumn;
    const endMeasure = Math.min(startMeasure + opts.measuresPerColumn, measureCount);
    const startBeat = chart.barLines[startMeasure]?.beat ?? 0;
    const endBeat = chart.barLines[endMeasure]?.beat ?? chart.totalBeats;
    const beats = endBeat - startBeat;
    columns.push({
      startMeasure,
      endMeasure,
      startBeat,
      endBeat,
      beats,
      height: beats * opts.pxPerBeat,
    });
  }

  // 列の最大高さで揃える
  const maxColumnHeight = Math.max(...columns.map((c) => c.height), opts.pxPerBeat * 4);
  const columnHeight = maxColumnHeight + opts.columnPadding * 2;

  const totalWidth =
    opts.marginLeft +
    opts.marginRight +
    totalColumns * columnWidth +
    Math.max(0, totalColumns - 1) * opts.columnGap;
  const totalHeight = opts.marginTop + opts.headerHeight + columnHeight + opts.marginBottom;

  const out: string[] = [];

  out.push(
    `<?xml version="1.0" encoding="UTF-8"?>` +
      `<svg xmlns="http://www.w3.org/2000/svg" width="${fmt(totalWidth)}" height="${fmt(
        totalHeight
      )}" viewBox="0 0 ${fmt(totalWidth)} ${fmt(totalHeight)}" font-family="'Helvetica Neue','Hiragino Sans','Yu Gothic',sans-serif">`
  );

  // <defs>: シンボル定義（ノート、地雷）
  out.push(buildDefs(opts));

  // 背景
  out.push(
    `<rect x="0" y="0" width="${fmt(totalWidth)}" height="${fmt(totalHeight)}" fill="${opts.background}"/>`
  );

  // ヘッダ（メタ情報）
  out.push(renderHeader(chart, totalWidth, opts));

  // 各列
  const columnsTop = opts.marginTop + opts.headerHeight;
  for (let i = 0; i < columns.length; i++) {
    const col = columns[i];
    const colX = opts.marginLeft + i * (columnWidth + opts.columnGap);
    out.push(renderColumn(chart, col, colX, columnsTop, columnHeight, slots, columnWidth, opts));
  }

  out.push(`</svg>`);
  return out.join('\n');
}

function buildDefs(opts: Required<RenderOptions>): string {
  return `<defs>
    <linearGradient id="lnGradient" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="white" stop-opacity="0.55"/>
      <stop offset="100%" stop-color="white" stop-opacity="0.15"/>
    </linearGradient>
    <pattern id="mineHatch" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
      <rect width="6" height="6" fill="#444"/>
      <line x1="0" y1="0" x2="0" y2="6" stroke="#cfcfcf" stroke-width="2"/>
    </pattern>
  </defs>`;
}

function renderHeader(chart: Chart, totalWidth: number, opts: Required<RenderOptions>): string {
  const m = chart.meta;
  const cx = opts.marginLeft;
  const cy = opts.marginTop;

  const left: string[] = [];
  if (m.genre) left.push(escapeXml(m.genre));
  const titleLine = m.subtitle ? `${m.title} ${m.subtitle}` : m.title;
  const artistLine = m.subartist ? `${m.artist} / ${m.subartist}` : m.artist;

  const right: string[] = [];
  right.push(`BPM ${fmt(m.initialBpm)}`);
  if (m.playLevel != null) right.push(`LEVEL ${m.playLevel}`);
  if (m.difficulty != null) {
    const labels = ['', 'BEGINNER', 'NORMAL', 'HYPER', 'ANOTHER', 'INSANE'];
    right.push(labels[m.difficulty] ?? `DIFF ${m.difficulty}`);
  }
  right.push(m.isDP ? 'DP' : 'SP');

  const totalNotes = chart.notes.filter((n) => n.kind === 'normal' || n.kind === 'long').length;
  right.push(`${totalNotes} NOTES`);

  return `<g class="header">
    <rect x="${fmt(cx - 6)}" y="${fmt(cy)}" width="${fmt(totalWidth - opts.marginLeft - opts.marginRight + 12)}" height="${fmt(
    opts.headerHeight - 6
  )}" fill="#161927" stroke="#272a3b"/>
    <text x="${fmt(cx + 4)}" y="${fmt(cy + 22)}" fill="#7d8497" font-size="11" letter-spacing="0.06em">${escapeXml(
      left.join('  /  ')
    )}</text>
    <text x="${fmt(cx + 4)}" y="${fmt(cy + 50)}" fill="#f5f6fa" font-size="22" font-weight="700">${escapeXml(
      titleLine
    )}</text>
    <text x="${fmt(cx + 4)}" y="${fmt(cy + 74)}" fill="#aab0c1" font-size="13">${escapeXml(artistLine)}</text>
    <text x="${fmt(totalWidth - opts.marginRight - 4)}" y="${fmt(cy + 50)}" fill="#dde0ed" font-size="14" text-anchor="end">${escapeXml(
      right.join('  ·  ')
    )}</text>
  </g>`;
}

function renderColumn(
  chart: Chart,
  col: { startMeasure: number; endMeasure: number; startBeat: number; endBeat: number; beats: number; height: number },
  colX: number,
  colTop: number,
  columnHeight: number,
  slots: LaneSlot[],
  columnWidth: number,
  opts: Required<RenderOptions>
): string {
  const out: string[] = [];

  // 列のベース。列の **底辺** が startBeat、上端が endBeat に対応（下→上）
  const colBottom = colTop + columnHeight - opts.columnPadding;
  const beatToY = (beat: number): number => {
    const offsetFromColStart = beat - col.startBeat;
    return colBottom - offsetFromColStart * opts.pxPerBeat;
  };

  // 列背景
  out.push(`<g class="col col-${col.startMeasure}">`);
  out.push(
    `<rect x="${fmt(colX)}" y="${fmt(colTop)}" width="${fmt(columnWidth)}" height="${fmt(
      columnHeight
    )}" fill="#13162a"/>`
  );

  // 各レーンの背景
  for (const slot of slots) {
    const isWhite =
      slot.lane.type === 'key' &&
      (slot.lane.index === 1 || slot.lane.index === 3 || slot.lane.index === 5 || slot.lane.index === 7);
    const isBlack =
      slot.lane.type === 'key' &&
      (slot.lane.index === 2 || slot.lane.index === 4 || slot.lane.index === 6);
    let bg = '#0d1023';
    if (slot.lane.type === 'scratch') bg = '#1a0c10';
    else if (isWhite) bg = '#0d1023';
    else if (isBlack) bg = '#0c0f1d';

    out.push(
      `<rect x="${fmt(colX + slot.x)}" y="${fmt(colTop)}" width="${fmt(slot.width)}" height="${fmt(
        columnHeight
      )}" fill="${bg}"/>`
    );
  }

  // 列の上下シルエット
  out.push(
    `<rect x="${fmt(colX)}" y="${fmt(colTop)}" width="${fmt(columnWidth)}" height="${fmt(
      columnHeight
    )}" fill="none" stroke="#262a45"/>`
  );

  // 細分線（小節内の罫線）。subdivisions に応じて複数粒度を重ね描き
  // 描画優先度（強い→弱い）: 拍 > 8分 > 12分(三連) > 16分 > 24分(三連x16) > 32分
  // 同じ位置に複数該当するときは強い方の色だけ採用するため、弱い順に描いて被ったらスキップ
  // 罫線の階層は「subdivisions の値で決まる単一の系列」にする。
  // 三連符(12,24)は2系列のため、16分系列とは混ぜない（混ざると不均一に見える）
  const subdivLevels: Array<{ div: number; stroke: string; width: number }> = [];
  subdivLevels.push({ div: 4, stroke: '#6a7396', width: 1.2 });
  const s = opts.subdivisions;
  if (s === 8) {
    subdivLevels.push({ div: 8, stroke: '#4a5072', width: 0.9 });
  } else if (s === 12) {
    // 三連符モード: 8分は出さず、12分(三連)を出す
    subdivLevels.push({ div: 12, stroke: '#7a4a5e', width: 0.85 });
  } else if (s === 16) {
    subdivLevels.push({ div: 8, stroke: '#4a5072', width: 0.9 });
    subdivLevels.push({ div: 16, stroke: '#363b58', width: 0.7 });
  } else if (s === 24) {
    // 三連符 + 24分
    subdivLevels.push({ div: 12, stroke: '#7a4a5e', width: 0.85 });
    subdivLevels.push({ div: 24, stroke: '#5a3845', width: 0.6 });
  } else if (s === 32) {
    subdivLevels.push({ div: 8, stroke: '#4a5072', width: 0.9 });
    subdivLevels.push({ div: 16, stroke: '#363b58', width: 0.7 });
    subdivLevels.push({ div: 32, stroke: '#272b42', width: 0.55 });
  } else if (s === 48) {
    // 16分 + 三連の混合
    subdivLevels.push({ div: 8, stroke: '#4a5072', width: 0.9 });
    subdivLevels.push({ div: 12, stroke: '#7a4a5e', width: 0.7 });
    subdivLevels.push({ div: 16, stroke: '#363b58', width: 0.6 });
  }

  for (let m = col.startMeasure; m < col.endMeasure; m++) {
    const bar = chart.barLines[m];
    if (!bar) continue;

    // 弱い順に描画（弱→強）。後から強い罫線を描けば視覚的に強が勝つ
    for (let li = subdivLevels.length - 1; li >= 0; li--) {
      const lv = subdivLevels[li];
      const totalDivs = lv.div * bar.ratio; // 小節内の刻み総数（拍子変化を考慮）
      for (let i = 1; i < totalDivs + 1e-9; i++) {
        // この位置がより強い分割と重なるならスキップ
        let dominated = false;
        for (let lj = 0; lj < li; lj++) {
          const stronger = subdivLevels[lj];
          const r = (i * stronger.div) / lv.div;
          if (Math.abs(r - Math.round(r)) < 1e-9 && Math.round(r) >= 1 && Math.round(r) < stronger.div * bar.ratio) {
            dominated = true;
            break;
          }
        }
        if (dominated) continue;

        const beatOffset = (i * 4) / lv.div;
        const y = beatToY(bar.beat + beatOffset);
        out.push(
          `<line x1="${fmt(colX)}" y1="${fmt(y)}" x2="${fmt(colX + columnWidth)}" y2="${fmt(
            y
          )}" stroke="${lv.stroke}" stroke-width="${lv.width}"/>`
        );
      }
    }
  }

  // 小節線（小節の **頭**）
  for (let m = col.startMeasure; m <= col.endMeasure; m++) {
    const bar = chart.barLines[m];
    if (!bar) continue;
    if (bar.beat < col.startBeat - 1e-6 || bar.beat > col.endBeat + 1e-6) continue;
    const y = beatToY(bar.beat);
    out.push(
      `<line x1="${fmt(colX)}" y1="${fmt(y)}" x2="${fmt(colX + columnWidth)}" y2="${fmt(
        y
      )}" stroke="#5e6488" stroke-width="1.4"/>`
    );
  }

  // BPM変化のライン（緑）
  for (const ev of chart.bpmEvents) {
    if (ev.beat < col.startBeat - 1e-6 || ev.beat >= col.endBeat - 1e-6) continue;
    if (ev.beat === 0 && col.startMeasure !== 0) continue;
    const y = beatToY(ev.beat);
    out.push(
      `<line x1="${fmt(colX)}" y1="${fmt(y)}" x2="${fmt(colX + columnWidth)}" y2="${fmt(
        y
      )}" stroke="#7cfc00" stroke-width="1" stroke-dasharray="3 2" opacity="0.85"/>`
    );
    out.push(
      `<text x="${fmt(colX + 2)}" y="${fmt(y - 2)}" font-size="9" fill="#7cfc00" opacity="0.95">${fmt(
        ev.bpm
      )}</text>`
    );
  }

  // STOPマーカー
  for (const ev of chart.stopEvents) {
    if (ev.beat < col.startBeat - 1e-6 || ev.beat >= col.endBeat - 1e-6) continue;
    const y = beatToY(ev.beat);
    out.push(
      `<line x1="${fmt(colX)}" y1="${fmt(y)}" x2="${fmt(colX + columnWidth)}" y2="${fmt(
        y
      )}" stroke="#ff8c42" stroke-width="1" opacity="0.85"/>`
    );
    out.push(
      `<text x="${fmt(colX + columnWidth - 2)}" y="${fmt(
        y - 2
      )}" font-size="9" fill="#ff8c42" text-anchor="end">STOP ${fmt(ev.durationBeats)}b</text>`
    );
  }

  // 小節番号
  for (let m = col.startMeasure; m < col.endMeasure; m++) {
    const bar = chart.barLines[m];
    if (!bar) continue;
    const y = beatToY(bar.beat) - 4;
    out.push(
      `<text x="${fmt(colX - 4)}" y="${fmt(
        y
      )}" font-size="10" fill="#8089a8" text-anchor="end" font-family="monospace">${m + 1}</text>`
    );
    if (Math.abs(bar.ratio - 1.0) > 1e-6) {
      out.push(
        `<text x="${fmt(colX - 4)}" y="${fmt(
          y - 11
        )}" font-size="9" fill="#caa257" text-anchor="end" font-family="monospace">${fmt(bar.ratio)}x</text>`
      );
    }
  }

  // ノートを描画
  // 順序: invisible -> mine -> long -> normal （重なり順）
  const order: Note['kind'][] = ['invisible', 'mine', 'long', 'normal'];
  for (const kind of order) {
    for (const note of chart.notes) {
      if (note.kind !== kind) continue;
      if (note.beat < col.startBeat - 1e-6) {
        // long が列をまたぐ場合に限り描画する
        if (note.kind === 'long' && note.endBeat !== undefined && note.endBeat > col.startBeat) {
          // OK
        } else {
          continue;
        }
      }
      if (note.beat >= col.endBeat - 1e-6 && note.kind !== 'long') continue;

      const targetSlots = laneSlots(slots, note.lane);
      if (targetSlots.length === 0) continue;

      if (note.kind === 'invisible') continue; // 描画しない

      // 同一レーンに複数スロットがある場合（SP表示の左右SCなど）、すべてに同じ図形を描く
      for (const slot of targetSlots) {
        const x = colX + slot.x + 1;
        const w = slot.width - 2;

        if (note.kind === 'mine') {
          const y = beatToY(note.beat);
          out.push(renderMine(x, y, w));
          continue;
        }

        if (note.kind === 'long' && note.endBeat !== undefined) {
          const yStart = beatToY(Math.min(col.endBeat, note.endBeat));
          const yEnd = beatToY(Math.max(col.startBeat, note.beat));
          const top = Math.min(yStart, yEnd);
          const bottom = Math.max(yStart, yEnd);
          const h = Math.max(opts.minNoteHeight, bottom - top);
          const style = laneStyle(note.lane);
          out.push(
            `<rect x="${fmt(x)}" y="${fmt(top)}" width="${fmt(w)}" height="${fmt(
              h
            )}" fill="${style.long}" stroke="${style.longStroke}" stroke-width="0.6" rx="1"/>`
          );
          out.push(
            `<rect x="${fmt(x)}" y="${fmt(top)}" width="${fmt(w)}" height="${fmt(
              h
            )}" fill="url(#lnGradient)" opacity="0.6"/>`
          );
          if (note.beat >= col.startBeat - 1e-6) {
            const yHead = beatToY(note.beat);
            out.push(
              `<rect x="${fmt(x)}" y="${fmt(yHead - 3)}" width="${fmt(w)}" height="3" fill="${style.fill}" stroke="${style.stroke}" stroke-width="0.6"/>`
            );
          }
          if (note.endBeat <= col.endBeat + 1e-6) {
            const yTail = beatToY(note.endBeat);
            out.push(
              `<rect x="${fmt(x)}" y="${fmt(yTail - 3)}" width="${fmt(w)}" height="3" fill="${style.fill}" stroke="${style.stroke}" stroke-width="0.6"/>`
            );
          }
          continue;
        }

        if (note.kind === 'normal') {
          const y = beatToY(note.beat);
          const style = laneStyle(note.lane);
          const noteH = note.lane.type === 'scratch' ? 5 : 4;
          out.push(
            `<rect x="${fmt(x)}" y="${fmt(y - noteH)}" width="${fmt(w)}" height="${fmt(
              noteH
            )}" fill="${style.fill}" stroke="${style.stroke}" stroke-width="0.6" rx="0.8"/>`
          );
        }
      }
    }
  }

  out.push(`</g>`);
  return out.join('\n');
}

function renderMine(x: number, y: number, w: number): string {
  const cx = x + w / 2;
  const r = Math.min(w / 2, 5);
  return `<g><circle cx="${fmt(cx)}" cy="${fmt(y - r)}" r="${fmt(
    r
  )}" fill="url(#mineHatch)" stroke="#cfcfcf" stroke-width="0.6"/><text x="${fmt(cx)}" y="${fmt(
    y - r + 3
  )}" font-size="8" fill="#fff" text-anchor="middle" font-weight="700">!</text></g>`;
}

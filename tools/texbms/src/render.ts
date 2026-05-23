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
  /** ノーツ高さ = pxPerBeat × この比率 (0.12 で 1拍の12%が音符の太さ。Textage的) */
  noteHeightRatio?: number;
  /** 小節番号テキストのフォントサイズ */
  measureLabelSize?: number;
  /** 列の上下に追加する余白（小節番号の余裕） */
  columnPadding?: number;
  /** 4小節ブロック同士の横の隙間 (column gap = ラベルパネル幅 と別) */
  blockGap?: number;
  /** 1拍を何分割まで罫線で見せるか。4=4分(拍のみ) / 8=8分 / 16=16分 / 24=三連符 / 32=32分 */
  subdivisions?: number;
  /** SP表示の向き。1=1P側(SC左), 2=2P側(SC右)。DPでは無視 */
  side?: 1 | 2;
}

// Textage 譜面のピクセル計測ベース
// 1列幅 = 270px (lane area 215 + label panel 55)
// 1拍 = 68px (4小節 × 4拍 × 68 ≈ 1088px の列高さ。これでビューポート1列を縦いっぱい)
const DEFAULTS: Required<RenderOptions> = {
  pxPerBeat: 55,
  measuresPerColumn: 4,
  laneKeyWidth: 22,
  laneScratchWidth: 60,
  columnGap: 55,
  marginLeft: 32,
  marginRight: 32,
  marginTop: 0,
  marginBottom: 0,
  headerHeight: 0,
  background: '#000000',
  showFreeZone: false,
  minNoteHeight: 3,
  noteHeightRatio: 0.105,
  measureLabelSize: 28,
  columnPadding: 8,
  blockGap: 12,
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

  // 列高さは譜面によらず固定 (Textage風: 1列=4小節を2段(各2小節)に分けて表示)。
  // 拍子変化を含む特殊小節があっても全部一定にして見た目を揃える。
  const noteHCap = Math.max(opts.minNoteHeight, opts.pxPerBeat * opts.noteHeightRatio) * 1.3;
  const effectivePadding = Math.max(opts.columnPadding, noteHCap);
  const measuresPerHalf = Math.ceil(opts.measuresPerColumn / 2);
  const halfContentHeight = measuresPerHalf * 4 * opts.pxPerBeat;
  const halfSeparator = 0; // halfSep=0 → 単一の白線で区切る
  const fixedColumnContentHeight = halfContentHeight * 2 + halfSeparator;
  const columnHeight = fixedColumnContentHeight + effectivePadding * 2;

  const totalWidth =
    opts.marginLeft +
    opts.marginRight +
    totalColumns * (columnWidth + opts.columnGap) +
    Math.max(0, totalColumns - 1) * opts.blockGap;
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
  if (opts.headerHeight > 0) out.push(renderHeader(chart, totalWidth, opts));

  // 各列
  const columnsTop = opts.marginTop + opts.headerHeight;
  for (let i = 0; i < columns.length; i++) {
    const col = columns[i];
    const colX = opts.marginLeft + i * (columnWidth + opts.columnGap + opts.blockGap);
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

  // padding は ノーツ高さで上端のはみ出し防止のため動的に確保
  const noteHCap = Math.max(opts.minNoteHeight, opts.pxPerBeat * opts.noteHeightRatio) * 1.3;
  const effectivePadding = Math.max(opts.columnPadding, noteHCap);
  const uniformMeasureHeight = 4 * opts.pxPerBeat;
  // Textage 風 2段構成 (上半=最初2小節、下半=後2小節)
  // 各半内では下→上が時系列順(早い小節が下)。
  // 列全体の構造 (上から下):
  //   padding | top-half (mRel=1 top, mRel=0 bottom) | separator | bottom-half (mRel=3 top, mRel=2 bottom) | padding
  const measuresPerHalfLocal = Math.ceil(opts.measuresPerColumn / 2);
  const halfContentH = measuresPerHalfLocal * uniformMeasureHeight;
  const halfSep = 0; // 上下半の境界(0=隙間なし、白線1本で区切る)
  const topHalfTopY = colTop + effectivePadding;
  const topHalfBottomY = topHalfTopY + halfContentH;
  const bottomHalfTopY = topHalfBottomY + halfSep;
  const bottomHalfBottomY = bottomHalfTopY + halfContentH;
  const colBottom = bottomHalfBottomY; // 旧 colBottom 互換

  // 小節 m (col.startMeasure 起点) の y 範囲
  // Textage準拠: 早い小節が下、遅い小節が上(= 全体読みは下→上で時系列順)
  // bottom half = mRel 0-1 (早い 2小節)、top half = mRel 2-3 (遅い 2小節)
  const measureRegion = (m: number): { topY: number; bottomY: number } => {
    const mRel = m - col.startMeasure;
    const inTopHalf = mRel >= measuresPerHalfLocal;
    const indexInHalf = inTopHalf ? mRel - measuresPerHalfLocal : mRel;
    // half 内では index 0 が下、index 1 が上
    const halfBottomY = inTopHalf ? topHalfBottomY : bottomHalfBottomY;
    const measureBottomY = halfBottomY - indexInHalf * uniformMeasureHeight;
    return { bottomY: measureBottomY, topY: measureBottomY - uniformMeasureHeight };
  };

  const beatToY = (beat: number): number => {
    for (let m = col.startMeasure; m < col.endMeasure; m++) {
      const bs = chart.barLines[m]?.beat ?? 0;
      const be = chart.barLines[m + 1]?.beat ?? bs + 4;
      if (beat >= bs - 1e-9 && beat <= be + 1e-9) {
        const ratio = (beat - bs) / (be - bs);
        const { bottomY, topY } = measureRegion(m);
        return bottomY - ratio * (bottomY - topY);
      }
    }
    // 列の上端 (col.endBeat) フォールバック → 最後の小節の上端
    if (beat >= col.endBeat - 1e-6) {
      return measureRegion(col.endMeasure - 1).topY;
    }
    // 列下端より下は線形外挿
    return bottomHalfBottomY + (col.startBeat - beat) * opts.pxPerBeat;
  };

  // 半段ごとの実際の小節数で描画範囲を決定 (部分列の空欄半段を消す)
  // bottom half = 早い小節 (mRel 0-1)、top half = 遅い小節 (mRel 2-3)
  const measuresInCol = col.endMeasure - col.startMeasure;
  const measuresInBottomHalf = Math.min(measuresPerHalfLocal, measuresInCol);
  const measuresInTopHalf = Math.max(0, measuresInCol - measuresPerHalfLocal);
  const topHalfActualH = measuresInTopHalf * uniformMeasureHeight;
  const bottomHalfActualH = measuresInBottomHalf * uniformMeasureHeight;
  // 半段の y範囲(actual): 各小節は半段の **下** から積み上げる(mRel=0 が一番下)
  const topHalfRenderTopY = topHalfBottomY - topHalfActualH;
  const bottomHalfRenderTopY = bottomHalfBottomY - bottomHalfActualH;

  // 列背景: 黒一色 (実小節分だけ)
  out.push(`<g class="col col-${col.startMeasure}">`);
  if (measuresInTopHalf > 0) {
    out.push(
      `<rect x="${fmt(colX)}" y="${fmt(topHalfRenderTopY)}" width="${fmt(columnWidth)}" height="${fmt(
        topHalfActualH
      )}" fill="#000000"/>`
    );
  }
  if (measuresInBottomHalf > 0) {
    out.push(
      `<rect x="${fmt(colX)}" y="${fmt(bottomHalfRenderTopY)}" width="${fmt(columnWidth)}" height="${fmt(
        bottomHalfActualH
      )}" fill="#000000"/>`
    );
  }
  // 灰色 label panel (実小節分だけ)
  const labelPanelX = colX + columnWidth;
  const labelPanelW = opts.columnGap;
  if (measuresInTopHalf > 0) {
    out.push(
      `<rect x="${fmt(labelPanelX)}" y="${fmt(topHalfRenderTopY)}" width="${fmt(labelPanelW)}" height="${fmt(
        topHalfActualH
      )}" fill="#7e7e7e"/>`
    );
  }
  if (measuresInBottomHalf > 0) {
    out.push(
      `<rect x="${fmt(labelPanelX)}" y="${fmt(bottomHalfRenderTopY)}" width="${fmt(labelPanelW)}" height="${fmt(
        bottomHalfActualH
      )}" fill="#7e7e7e"/>`
    );
  }

  // レーン縦線(各レーン境界に薄いグリッド、実小節分だけ)
  {
    let xCursor = colX;
    for (let s = 0; s < slots.length - 1; s++) {
      xCursor += slots[s].width;
      if (measuresInTopHalf > 0) {
        out.push(
          `<line x1="${fmt(xCursor)}" y1="${fmt(topHalfRenderTopY)}" x2="${fmt(xCursor)}" y2="${fmt(topHalfBottomY)}" stroke="#505050" stroke-width="0.4"/>`
        );
      }
      if (measuresInBottomHalf > 0) {
        out.push(
          `<line x1="${fmt(xCursor)}" y1="${fmt(bottomHalfRenderTopY)}" x2="${fmt(xCursor)}" y2="${fmt(bottomHalfBottomY)}" stroke="#505050" stroke-width="0.4"/>`
        );
      }
    }
  }

  // 細分線（小節内の罫線）。subdivisions に応じて複数粒度を重ね描き
  // 描画優先度（強い→弱い）: 拍 > 8分 > 12分(三連) > 16分 > 24分(三連x16) > 32分
  // 同じ位置に複数該当するときは強い方の色だけ採用するため、弱い順に描いて被ったらスキップ
  // 罫線の階層は「subdivisions の値で決まる単一の系列」にする。
  // 三連符(12,24)は2系列のため、16分系列とは混ぜない（混ざると不均一に見える）
  const subdivLevels: Array<{ div: number; stroke: string; width: number }> = [];
  subdivLevels.push({ div: 4, stroke: '#808080', width: 0.6 });  // 拍線
  const s = opts.subdivisions;
  if (s === 8) {
    subdivLevels.push({ div: 8, stroke: '#404040', width: 0.4 });
  } else if (s === 12) {
    subdivLevels.push({ div: 12, stroke: '#5a3030', width: 0.4 });
  } else if (s === 16) {
    subdivLevels.push({ div: 8, stroke: '#606060', width: 0.5 });
    subdivLevels.push({ div: 16, stroke: '#505050', width: 0.45 });
  } else if (s === 24) {
    subdivLevels.push({ div: 12, stroke: '#5a3030', width: 0.4 });
    subdivLevels.push({ div: 24, stroke: '#3a2020', width: 0.3 });
  } else if (s === 32) {
    subdivLevels.push({ div: 8, stroke: '#505050', width: 0.5 });
    subdivLevels.push({ div: 16, stroke: '#303030', width: 0.35 });
    subdivLevels.push({ div: 32, stroke: '#202020', width: 0.25 });
  } else if (s === 48) {
    subdivLevels.push({ div: 8, stroke: '#505050', width: 0.5 });
    subdivLevels.push({ div: 12, stroke: '#5a3030', width: 0.4 });
    subdivLevels.push({ div: 16, stroke: '#303030', width: 0.3 });
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
    // 白い小節境界線は label panel まで伸ばす(統一感)
    out.push(
      `<line x1="${fmt(colX)}" y1="${fmt(y)}" x2="${fmt(colX + columnWidth + opts.columnGap)}" y2="${fmt(
        y
      )}" stroke="#ffffff" stroke-width="1"/>`
    );
  }

  // ブロック白枠 (top-half, bottom-half それぞれ実小節分だけ)
  const blockRightX = colX + columnWidth + opts.columnGap;
  if (measuresInTopHalf > 0) {
    out.push(
      `<rect x="${fmt(colX)}" y="${fmt(topHalfRenderTopY)}" width="${fmt(blockRightX - colX)}" height="${fmt(topHalfActualH)}" fill="none" stroke="#ffffff" stroke-width="1"/>`
    );
  }
  if (measuresInBottomHalf > 0) {
    out.push(
      `<rect x="${fmt(colX)}" y="${fmt(bottomHalfRenderTopY)}" width="${fmt(blockRightX - colX)}" height="${fmt(bottomHalfActualH)}" fill="none" stroke="#ffffff" stroke-width="1"/>`
    );
  }

  // BPM変化のライン (チャートエリア部分のみ、ここで先に薄く描画 → label panel 上は最後に再描画)
  for (const ev of chart.bpmEvents) {
    if (ev.beat < col.startBeat - 1e-6 || ev.beat >= col.endBeat - 1e-6) continue;
    if (ev.beat === 0 && col.startMeasure !== 0) continue;
    const y = beatToY(ev.beat);
    out.push(
      `<line x1="${fmt(colX)}" y1="${fmt(y)}" x2="${fmt(colX + columnWidth)}" y2="${fmt(
        y
      )}" stroke="#7cfc00" stroke-width="1" stroke-dasharray="3 2" opacity="0.85"/>`
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

  // ラベルテキスト(panel rect は背景と一緒に既に描画済、ここでは text のみ)
  for (let m = col.startMeasure; m < col.endMeasure; m++) {
    const { topY: measureTopY, bottomY: measureBottomY } = measureRegion(m);
    const yCenter = (measureTopY + measureBottomY) / 2 + opts.measureLabelSize * 0.35;
    out.push(
      `<text x="${fmt(labelPanelX + labelPanelW / 2)}" y="${fmt(
        yCenter
      )}" font-size="${fmt(opts.measureLabelSize)}" fill="#ffffff" text-anchor="middle" font-weight="bold" font-family="'Helvetica Neue',Arial,sans-serif">${m + 1}</text>`
    );
    const bar = chart.barLines[m];
    if (bar && Math.abs(bar.ratio - 1.0) > 1e-6) {
      out.push(
        `<text x="${fmt(labelPanelX + labelPanelW / 2)}" y="${fmt(
          yCenter + opts.measureLabelSize * 0.7
        )}" font-size="${fmt(opts.measureLabelSize * 0.5)}" fill="#7a3030" text-anchor="middle" font-family="monospace">${fmt(bar.ratio)}x</text>`
      );
    }
  }

  // ノートを描画
  // 順序: invisible -> mine -> long -> normal （重なり順）
  const order: Note['kind'][] = ['invisible', 'mine', 'long', 'normal'];
  for (const kind of order) {
    for (const note of chart.notes) {
      if (note.kind !== kind) continue;
      if (note.kind === 'long') {
        // LN: 区間 [note.beat, note.endBeat] が列の [startBeat, endBeat] と重なる時のみ描画
        if (note.beat >= col.endBeat - 1e-6) continue;        // LN が現列より右(=後)で始まる
        if (note.endBeat !== undefined && note.endBeat <= col.startBeat + 1e-6) continue; // LN が現列より左(=前)で終わる
      } else {
        // 通常/mine: note.beat が列範囲内のときだけ
        if (note.beat < col.startBeat - 1e-6) continue;
        if (note.beat >= col.endBeat - 1e-6) continue;
      }

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
          // yStart = LN 上端y(時系列で言うとendBeat側)、yEnd = LN 下端y(beat側)
          const yStart = beatToY(Math.min(col.endBeat, note.endBeat));
          const yEnd = beatToY(Math.max(col.startBeat, note.beat));
          const style = laneStyle(note.lane);
          const baseH = Math.max(opts.minNoteHeight, opts.pxPerBeat * opts.noteHeightRatio);
          const noteH = note.lane.type === 'scratch' ? baseH * 1.2 : baseH;
          const headInCol = note.beat >= col.startBeat - 1e-6;
          const tailInCol = note.endBeat <= col.endBeat + 1e-6;
          // body は少し狭め(65%幅)で head/tail の間を埋める
          const bodyW = w * 0.65;
          const bodyX = x + (w - bodyW) / 2;
          const bodyTopY = yStart;
          const bodyBottomY = headInCol ? yEnd - noteH : yEnd;
          const bodyH = bodyBottomY - bodyTopY;
          if (bodyH > 0.5) {
            out.push(
              `<rect x="${fmt(bodyX)}" y="${fmt(bodyTopY)}" width="${fmt(bodyW)}" height="${fmt(
                bodyH
              )}" fill="${style.long}" stroke="${style.longStroke}" stroke-width="0.6"/>`
            );
          }
          // head (LN開始 = 通常ノーツと同じ表示)
          if (headInCol) {
            out.push(
              `<rect x="${fmt(x)}" y="${fmt(yEnd - noteH)}" width="${fmt(w)}" height="${fmt(noteH)}" fill="${style.fill}" stroke="${style.stroke}" stroke-width="0.6" rx="0.8"/>`
            );
          }
          // tail (LN終端 = 通常ノーツと同じ表示)
          if (tailInCol) {
            out.push(
              `<rect x="${fmt(x)}" y="${fmt(yStart - noteH)}" width="${fmt(w)}" height="${fmt(noteH)}" fill="${style.fill}" stroke="${style.stroke}" stroke-width="0.6" rx="0.8"/>`
            );
          }
          continue;
        }

        if (note.kind === 'normal') {
          const y = beatToY(note.beat);
          const style = laneStyle(note.lane);
          const baseH = Math.max(opts.minNoteHeight, opts.pxPerBeat * opts.noteHeightRatio);
          const noteH = note.lane.type === 'scratch' ? baseH * 1.2 : baseH;
          out.push(
            `<rect x="${fmt(x)}" y="${fmt(y - noteH)}" width="${fmt(w)}" height="${fmt(
              noteH
            )}" fill="${style.fill}" stroke="${style.stroke}" stroke-width="0.6" rx="0.8"/>`
          );
        }
      }
    }
  }

  // BPM 変化の緑線とテキスト (label panel 上、最後に描画して z-order 最前面)
  for (const ev of chart.bpmEvents) {
    if (ev.beat < col.startBeat - 1e-6 || ev.beat >= col.endBeat - 1e-6) continue;
    if (ev.beat === 0 && col.startMeasure !== 0) continue;
    const y = beatToY(ev.beat);
    // 緑線を label panel 部分にも伸ばす(全幅)
    out.push(
      `<line x1="${fmt(colX)}" y1="${fmt(y)}" x2="${fmt(colX + columnWidth + opts.columnGap)}" y2="${fmt(
        y
      )}" stroke="#7cfc00" stroke-width="1.2" stroke-dasharray="3 2"/>`
    );
    // BPM 数字 (panel 中央)
    out.push(
      `<text x="${fmt(labelPanelX + labelPanelW / 2)}" y="${fmt(y - 3)}" font-size="13" font-weight="bold" fill="#7cfc00" text-anchor="middle" font-family="'Helvetica Neue',Arial,sans-serif" stroke="#000000" stroke-width="2" paint-order="stroke">${fmt(ev.bpm)}</text>`
    );
  }

  out.push(`</g>`);
  return out.join('\n');
}

function renderMine(x: number, y: number, w: number): string {
  // ノーツと同じ幅の横長ハッチ柄バー(地雷=避けるべきノーツとして目立たせる)
  const h = 6;
  return `<g><rect x="${fmt(x)}" y="${fmt(y - h)}" width="${fmt(w)}" height="${fmt(
    h
  )}" fill="url(#mineHatch)" stroke="#ff5555" stroke-width="0.8"/></g>`;
}

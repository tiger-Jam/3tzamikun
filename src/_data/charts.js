// 難易度表JSONとレジストリを統合した譜面リスト。
// 11ty テンプレートから `charts.byTable['genocide']` 等で参照する。

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import registry from "./registry.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const readJson = (p) => JSON.parse(readFileSync(join(__dirname, p), "utf8"));

// VERSION 行の並び。Textage の VERSION 概念を「難易度表種別」に置き換える。
// kind: "primary" = 表側のラベル列を持つ / "others" = まとめバケツ
const TABLES = [
	{ id: "normal", file: "tables/normal.json", label: "Normal", short: "Normal", symbolOverride: "☆", kind: "primary" },
	{ id: "genocide", file: "tables/genocide.json", label: "Insane", short: "Insane", symbolOverride: "★", kind: "primary" },
	{ id: "stella_st", file: "tables/stella_st.json", label: "Stella", short: "St", kind: "primary" },
	{ id: "satellite_sl", file: "tables/satellite_sl.json", label: "Satellite", short: "Sl", kind: "primary" },
	{ id: "overjoy", file: "tables/overjoy.json", label: "Overjoy", short: "Overjoy", symbolOverride: "★★", kind: "primary" },
	// 将来追加する表は kind: "others" を付けて ↓ に並べる
];

// 差分グルーピング用に「曲のベースタイトル」を取り出す。末尾の括弧書き／鉤括弧書きを
// 順次剥がす（"Foo (★1) [ANOTHER]" → "Foo"）。括弧書きは BMS だと譜面派生名の慣習。
function deriveBaseTitle(title) {
	if (!title) return "";
	const stripRe = /\s*[\[\(（【［][^\]\)）】］]*[\]\)）】］]\s*$/;
	let s = title;
	let prev;
	do {
		prev = s;
		s = s.replace(stripRe, "").trim();
	} while (s !== prev);
	return s;
}

function normalizeEntry(raw, table) {
	const md5 = raw.md5 ?? "";
	const sha256 = raw.sha256 ?? "";
	// URL キー。md5 優先、なければ sha256 を使う（beatoraja向けのsha256-only譜面対策）
	const key = md5 || sha256;
	const ext = registry[md5] ?? registry[sha256] ?? null;
	const title = raw.title ?? "(タイトル不明)";
	return {
		table: table.id,
		tableLabel: table.label,
		tableShort: table.short,
		tableSymbol: table.symbolOverride ?? table.header.symbol ?? "?",
		level: String(raw.level ?? "?"),
		md5,
		sha256,
		key,
		title,
		baseTitle: deriveBaseTitle(title),
		artist: raw.artist ?? "",
		url: raw.url ?? "",
		urlDiff: raw.url_diff ?? "",
		nameDiff: raw.name_diff ?? "",
		comment: raw.comment ?? "",
		// 拡張メタ（未登録時 null）
		bpm: ext?.bpm ?? null,
		notes: ext?.notes ?? null,
		durationSec: ext?.durationSec ?? null,
		genre: ext?.genre ?? "",
		videoUrl: ext?.videoUrl ?? "",
		groupId: ext?.groupId ?? null,
		registered: ext != null,
	};
}

const result = {
	tables: {},
	byTable: {},
	primary: [],   // VERSION行の主スロット ["genocide", "stella_st", "satellite_sl"]
	others: [],    // VERSION行の "others" バケツ
	all: [],
	byMd5: {},     // md5 → entry. 段位コースの曲名解決用
};

// グループ内コース名から代表ラベルを抽出。
//   - 全コースに共通する先頭単語列があればそれを採用 ("2009 発狂初段","2009 発狂二段" → "2009")
//   - 完全一致しない場合、過半数を占める最頻出の先頭単語を採用 (混在グループでも "初代" のように代表名を出せる)
//   - それも引けなければ "セット N"
function deriveGroupLabel(names, fallbackIndex) {
	if (!names || names.length === 0) return `セット ${fallbackIndex + 1}`;
	const splits = names.map((n) => (n ?? "").split(/\s+/));
	// 1) 共通プレフィックス
	const minLen = Math.min(...splits.map((s) => s.length));
	const prefix = [];
	for (let i = 0; i < minLen; i++) {
		const w = splits[0][i];
		if (splits.every((s) => s[i] === w)) prefix.push(w);
		else break;
	}
	if (prefix.length > 0) return prefix.join(" ");
	// 2) 最頻出の先頭単語
	const counts = new Map();
	for (const s of splits) {
		const w = s[0] ?? "";
		counts.set(w, (counts.get(w) ?? 0) + 1);
	}
	let best = "", bestN = 0;
	for (const [w, n] of counts) if (n > bestN) { best = w; bestN = n; }
	if (best && bestN * 2 >= names.length) return `${best} 系`;
	// 3) フォールバック
	return `セット ${fallbackIndex + 1}`;
}

function slugifyGen(label, idx) {
	const cleaned = (label ?? "").replace(/[^A-Za-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
	return cleaned || `g${idx + 1}`;
}

function annotateCourses(rawCourses) {
	if (!Array.isArray(rawCourses)) return { groups: [], totalCount: 0 };

	// 1) outer group を平坦化（order保持）。表によっては2D / 1D 両方ある。
	const flat = [];
	for (const item of rawCourses) {
		if (Array.isArray(item)) flat.push(...item);
		else if (item && typeof item === "object") flat.push(item);
	}

	// 2) コース名の先頭単語が連続して同じものを1クラスタにまとめる（順序保持）。
	//    Stella の "Stella Skill Simulator 4th" / "STELLA技能訓練 st" や
	//    GENOSIDE の "初代 発狂" / "2007 発狂" / "2009 発狂" / "2012 発狂" /
	//    "GENOSIDE 2018 段位認定" のように、頭の単語が世代を表すケースを拾う。
	const firstWord = (c) => (c.name ?? "").split(/\s+/)[0] ?? "";
	const clusters = [];
	let cur = [];
	for (const c of flat) {
		if (cur.length === 0 || firstWord(cur[0]) === firstWord(c)) {
			cur.push(c);
		} else {
			clusters.push(cur);
			cur = [c];
		}
	}
	if (cur.length > 0) clusters.push(cur);

	// 3) スラグ重複対策。同じ先頭単語のクラスタが離れて出現する可能性に備える。
	const slugCount = new Map();
	const groups = clusters.map((grp, idx) => {
		const names = grp.map((c) => c.name ?? "");
		const label = deriveGroupLabel(names, idx);
		let slug = slugifyGen(label, idx);
		const seen = slugCount.get(slug) ?? 0;
		slugCount.set(slug, seen + 1);
		if (seen > 0) slug = `${slug}_${seen + 1}`;
		return {
			index: idx,
			slug,
			label,
			courses: grp,
			count: grp.length,
		};
	});

	return { groups, totalCount: groups.reduce((n, g) => n + g.count, 0) };
}

for (const table of TABLES) {
	const j = readJson(table.file);
	const tableInfo = {
		id: table.id,
		label: table.label,
		short: table.short,
		symbol: table.symbolOverride ?? j.header.symbol ?? "?",
		kind: table.kind,
		header: j.header,
		levelOrder: j.header.level_order ?? null,
		courses: j.header.course ?? [],
		courseInfo: annotateCourses(j.header.course ?? []),
	};
	result.tables[table.id] = tableInfo;
	if (table.kind === "primary") result.primary.push(table.id);
	else result.others.push(table.id);
	const entries = j.data.map((raw) =>
		normalizeEntry(raw, { ...table, header: j.header }),
	);
	result.byTable[table.id] = entries;
	result.all.push(...entries);
}

// md5 → entry インデックス（同じmd5が複数表にある場合は最初のものを採用）
for (const e of result.all) {
	if (e.md5 && !result.byMd5[e.md5]) result.byMd5[e.md5] = e;
}

// baseTitle → entry[] インデックス。groupId 未設定時のフォールバック。
result.byBaseTitle = {};
for (const e of result.all) {
	if (!e.baseTitle) continue;
	(result.byBaseTitle[e.baseTitle] ??= []).push(e);
}

// groupId → entry[] インデックス。レジストリで明示的に紐付けた差分グループ。
result.byGroup = {};
for (const e of result.all) {
	if (!e.groupId) continue;
	(result.byGroup[e.groupId] ??= []).push(e);
}

function sortLevels(levels) {
	const arr = Array.from(new Set(levels));
	return arr.sort((a, b) => {
		const na = Number(a), nb = Number(b);
		const aN = Number.isFinite(na), bN = Number.isFinite(nb);
		if (aN && bN) return na - nb;
		if (aN) return -1;
		if (bN) return 1;
		return String(a).localeCompare(String(b));
	});
}
for (const id of Object.keys(result.byTable)) {
	const t = result.tables[id];
	t.levels = sortLevels(result.byTable[id].map((e) => e.level));
	t.byLevel = Object.fromEntries(
		t.levels.map((lv) => [lv, result.byTable[id].filter((e) => e.level === lv)]),
	);
}

// (table, level) のフラット配列。ページ生成用。
result.levelPages = [];
for (const id of Object.keys(result.byTable)) {
	const t = result.tables[id];
	for (const lv of t.levels) {
		const slug =
			String(lv)
				.replace(/\+/g, "p")
				.replace(/-/g, "m")
				.replace(/[^A-Za-z0-9]+/g, "_") || "x";
		result.levelPages.push({
			tableId: id,
			tableLabel: t.label,
			tableShort: t.short,
			tableSymbol: t.symbol,
			level: lv,
			levelSlug: slug,
			entries: t.byLevel[lv],
		});
	}
}

// (table, generation) のフラット配列。世代別段位ページ生成用。
// 1世代のみの表でも生成する（段位認定行を常に出す方針なので）
result.coursePages = [];
for (const id of Object.keys(result.byTable)) {
	const t = result.tables[id];
	if (!t.courseInfo || t.courseInfo.totalCount === 0) continue;
	for (const grp of t.courseInfo.groups) {
		result.coursePages.push({
			tableId: id,
			tableLabel: t.label,
			tableShort: t.short,
			tableSymbol: t.symbol,
			genSlug: grp.slug,
			genLabel: grp.label,
			courses: grp.courses,
			count: grp.count,
		});
	}
}

export default result;

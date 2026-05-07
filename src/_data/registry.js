// 譜面拡張メタの登録レジストリ。
// 実データは同フォルダの registry.json (TexBMS の --batch 出力をマージ) から読み込む。
// 手動エントリを足したい場合はこの inline オブジェクトに書ける。
//
// フィールド:
//   bpm:          number     代表BPM
//   notes:        number     ノーツ数
//   durationSec:  number     曲長（秒）
//   genre:        string     ジャンル
//   videoUrl:     string     YouTube等の動画URL
//   groupId:      string     差分グループID。同 groupId の譜面は相互に「差分」扱い。
//                            TexBMS が --batch 時にフォルダ名を自動付与する。
//
// SVGパス: /assets/score/{md5}/{1p|2p|1pm|2pm}.svg

import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const jsonPath = join(__dirname, "registry.json");

// TexBMS が出力した registry.json があれば読む
const fromJson = existsSync(jsonPath)
	? JSON.parse(readFileSync(jsonPath, "utf8"))
	: {};

// 手動オーバーライドはここに足す（同じmd5があれば優先）
const manual = {};

export default { ...fromJson, ...manual };

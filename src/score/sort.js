// テーブルの列ヘッダクリックでソート。data-v 属性が値（文字列 or 数値）。
// rowspan/colspan ありの thead に対応するため、各ヘッダ index を実際の tbody セル index に
// 換算するインデックスを構築してから比較する。
(function () {
	function attachSort(table) {
		const tbody = table.tBodies[0];
		if (!tbody) return;
		const headers = table.tHead.rows[0].cells;

		// header[i] が tbody 行の cells[colIndex[i]] に対応する
		const colIndex = [];
		let cursor = 0;
		for (let i = 0; i < headers.length; i++) {
			colIndex.push(cursor);
			cursor += headers[i].colSpan || 1;
		}

		let lastIdx = -1;
		let lastDir = 1;
		for (let i = 0; i < headers.length; i++) {
			const th = headers[i];
			const key = th.getAttribute("data-sort");
			if (!key) continue;
			th.style.cursor = "pointer";
			const targetCol = colIndex[i];
			th.addEventListener("click", () => {
				const dir = i === lastIdx ? -lastDir : 1;
				lastIdx = i;
				lastDir = dir;
				const rows = Array.from(tbody.rows);
				rows.sort((a, b) => {
					const av =
						a.cells[targetCol]?.getAttribute("data-v") ??
						a.cells[targetCol]?.textContent ??
						"";
					const bv =
						b.cells[targetCol]?.getAttribute("data-v") ??
						b.cells[targetCol]?.textContent ??
						"";
					const an = Number(av), bn = Number(bv);
					const aN = Number.isFinite(an);
					const bN = Number.isFinite(bn);
					if (aN && bN) return (an - bn) * dir;
					// Lv 列のように数値+特殊値("???"等)が混じる時、
					// 特殊値はソート方向によらず常に末尾に固定
					if (key === "level") {
						if (aN) return -1;
						if (bN) return 1;
					}
					return String(av).localeCompare(String(bv), "ja") * dir;
				});
				for (const r of rows) tbody.appendChild(r);
				for (let j = 0; j < headers.length; j++) {
					headers[j].dataset.sortDir = "";
				}
				th.dataset.sortDir = dir > 0 ? "asc" : "desc";
			});
		}
	}
	for (const t of document.querySelectorAll("table.sortable")) {
		attachSort(t);
	}
})();

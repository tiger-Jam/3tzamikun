export default function (eleventyConfig) {
	eleventyConfig.addPassthroughCopy("src/style.css");
	eleventyConfig.addPassthroughCopy("src/assets");
	eleventyConfig.addPassthroughCopy("src/score/sort.js");

	eleventyConfig.addCollection("tools", (api) =>
		api.getFilteredByGlob("src/tools/*.md").sort((a, b) => (a.data.order ?? 99) - (b.data.order ?? 99)),
	);

	eleventyConfig.addCollection("posts", (api) =>
		api
			.getFilteredByGlob("src/blog/*.md")
			.sort((a, b) => b.date - a.date),
	);

	eleventyConfig.addFilter("ymd", (d) => {
		const x = new Date(d);
		return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, "0")}-${String(x.getDate()).padStart(2, "0")}`;
	});

	eleventyConfig.addFilter("countWhere", (arr, key) =>
		(arr ?? []).reduce((n, x) => n + (x?.[key] ? 1 : 0), 0),
	);

	// Nunjucks の `slice(N)` は「N分割」なので「先頭N件」用の filter を別途用意
	eleventyConfig.addFilter("take", (arr, n) => (arr ?? []).slice(0, n));

	// 同一 baseTitle 配列から自分自身（key一致）を除外
	eleventyConfig.addFilter("excludeKey", (arr, key) =>
		(arr ?? []).filter((x) => x?.key !== key),
	);

	eleventyConfig.addFilter("levelSlug", (lv) => {
		const s = String(lv ?? "")
			.replace(/\+/g, "p")
			.replace(/-/g, "m")
			.replace(/[^A-Za-z0-9]+/g, "_");
		return s || "x";
	});

	eleventyConfig.addFilter("ytId", (url) => {
		if (!url) return null;
		const m = String(url).match(
			/(?:youtu\.be\/|youtube\.com\/(?:watch\?v=|embed\/|shorts\/))([A-Za-z0-9_-]{6,})/,
		);
		return m ? m[1] : null;
	});

	// JSON を data: URL にして <a download> でダウンロードさせる
	eleventyConfig.addFilter("jsonDataUrl", (obj) => {
		const s = JSON.stringify(obj, null, 2);
		return `data:application/json;charset=utf-8,${encodeURIComponent(s)}`;
	});

	// 段位コース名をファイル名安全に
	eleventyConfig.addFilter("safeFileName", (s) =>
		String(s ?? "course").replace(/[^A-Za-z0-9._぀-ヿ一-鿿-]+/g, "_"),
	);

	return {
		dir: { input: "src", output: "_site", includes: "_includes", data: "_data" },
		templateFormats: ["njk", "md", "html"],
		markdownTemplateEngine: "njk",
		htmlTemplateEngine: "njk",
	};
}

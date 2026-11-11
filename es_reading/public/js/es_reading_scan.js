/* ES Reading — reads the text out of a PDF in the browser.
 *
 * Shared by the reading page (/reading) and the Reading Book form in the Desk.
 * Needs PDF.js (vendor/pdfjs/pdf.min.js) to be loaded first.
 */
(function () {
	"use strict";

	const WORKER = "/assets/es_reading/vendor/pdfjs/pdf.worker.min.js";
	const cache = {};

	function pdfLib() {
		const lib = window.pdfjsLib || window["pdfjs-dist/build/pdf"];
		if (lib && !lib.GlobalWorkerOptions.workerSrc) lib.GlobalWorkerOptions.workerSrc = WORKER;
		return lib;
	}

	async function openPdf(url) {
		if (!cache[url]) cache[url] = pdfLib().getDocument(url).promise;
		return cache[url];
	}

	/** Find the lines of text on every page, with each line's position as a fraction of the page. */
	async function extractPdf(url, onPage) {
		const lib = pdfLib();
		const pdf = await openPdf(url);
		const pages = [];
		for (let n = 1; n <= pdf.numPages; n++) {
			if (onPage) onPage(n, pdf.numPages);
			const page = await pdf.getPage(n);
			const view = page.getViewport({ scale: 1 });
			const content = await page.getTextContent();
			const items = [];
			for (const item of content.items) {
				if (!item.str || !item.str.trim()) continue;
				const t = lib.Util.transform(view.transform, item.transform);
				const size = Math.hypot(t[2], t[3]) || item.height || 10;
				items.push({ str: item.str, x: t[4], base: t[5], size, width: item.width });
			}
			items.sort((a, b) => a.base - b.base || a.x - b.x);
			const lines = [];
			for (const item of items) {
				const last = lines[lines.length - 1];
				if (last && Math.abs(item.base - last.base) < Math.max(2, last.size * 0.45)) last.items.push(item);
				else lines.push({ base: item.base, size: item.size, items: [item] });
			}
			const out = [];
			for (const line of lines) {
				line.items.sort((a, b) => a.x - b.x);
				let text = "";
				let end = null;
				let size = 0;
				for (const item of line.items) {
					if (end !== null && item.x - end > item.size * 0.2 && !/\s$/.test(text) && !/^\s/.test(item.str)) text += " ";
					text += item.str;
					end = item.x + item.width;
					size = Math.max(size, item.size);
				}
				text = text.replace(/\s+/g, " ").trim();
				if (!text) continue;
				const x0 = line.items[0].x;
				out.push({
					text,
					x: (x0 - 2) / view.width,
					y: (line.base - size * 0.95) / view.height,
					w: (end - x0 + 4) / view.width,
					h: (size * 1.3) / view.height,
				});
			}
			pages.push({ page: n, lines: out });
		}
		const cover = await renderPageOne(pdf);
		return { pages, pageCount: pdf.numPages, cover };
	}

	/** A small JPEG of page 1, used as the book's default picture. */
	async function renderPageOne(pdf) {
		try {
			const first = await pdf.getPage(1);
			const base = first.getViewport({ scale: 1 });
			const view = first.getViewport({ scale: 420 / base.width });
			const canvas = document.createElement("canvas");
			canvas.width = Math.round(view.width);
			canvas.height = Math.round(view.height);
			await first.render({ canvasContext: canvas.getContext("2d"), viewport: view }).promise;
			return canvas.toDataURL("image/jpeg", 0.8);
		} catch (e) { console.warn("cover", e); return null; }
	}

	window.ESReadingScan = { openPdf, extractPdf, renderPageOne };
})();

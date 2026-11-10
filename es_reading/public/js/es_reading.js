/* ES Reading — read-along page (/reading)
 *
 * Speech runs in the browser: speechSynthesis reads aloud, SpeechRecognition listens.
 * The server stores books, readers and sessions, and talks to Claude for the text work.
 */
(function () {
	"use strict";

	const CFG = window.ES_READING || {};
	const app = document.getElementById("app");
	const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
	const synth = window.speechSynthesis;
	const LANG = {
		"Australia": "en-AU",
		"United Kingdom": "en-GB",
		"United States": "en-US",
		"New Zealand": "en-NZ",
		"Ireland": "en-IE",
		"Canada": "en-CA",
		"South Africa": "en-ZA",
		"India": "en-IN",
	};
	const AVATARS = ["🦊", "🐨", "🦘", "🐢", "🦉", "🐬", "🦋", "🐙", "🦄", "🐯", "🚀", "🌈"];
	const MODE_LABEL = {
		"Read Together": "Read together",
		"Re-read": "I'll read it myself",
		"Listen": "Just listen",
		"Tricky Words": "Tricky words",
	};

	const S = {
		boot: null,
		reader: null,
		voices: [],
		book: null,
		pdf: null,
		pdfCache: {},
		run: null, // the active reading run; replaced to cancel everything in flight
		lastHelped: [],
		progress: {},
	};

	// ------------------------------------------------------------------ small helpers

	function h(tag, attrs, ...kids) {
		const el = document.createElement(tag);
		for (const [k, v] of Object.entries(attrs || {})) {
			if (v == null || v === false) continue;
			if (k === "class") el.className = v;
			else if (k === "style") el.style.cssText = v;
			else if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
			else if (k === "html") el.innerHTML = v;
			else el.setAttribute(k, v === true ? "" : v);
		}
		for (const kid of kids.flat()) {
			if (kid == null || kid === false) continue;
			el.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
		}
		return el;
	}

	function show(...nodes) {
		app.replaceChildren(...nodes.flat().filter(Boolean));
		window.scrollTo(0, 0);
	}

	function toast(message, ms) {
		document.querySelectorAll(".toast").forEach((t) => t.remove());
		const t = h("div", { class: "toast", role: "status" }, message);
		document.body.append(t);
		setTimeout(() => t.remove(), ms || 4000);
	}

	function modal(title, body, actions) {
		const veil = h("div", { class: "veil" });
		const close = () => veil.remove();
		veil.append(h("div", { class: "modal", role: "dialog", "aria-label": title }, h("h2", {}, title), body, h("div", { class: "actions" }, actions(close))));
		veil.addEventListener("click", (e) => e.target === veil && close());
		document.body.append(veil);
		return close;
	}

	function clock(seconds) {
		seconds = Math.max(0, Math.round(seconds || 0));
		const m = Math.floor(seconds / 60);
		const s = seconds % 60;
		return m ? `${m} min ${s} s` : `${s} s`;
	}

	function serverMessage(data) {
		try {
			if (data._server_messages) {
				const first = JSON.parse(JSON.parse(data._server_messages)[0]);
				return String(first.message || "").replace(/<[^>]+>/g, "");
			}
		} catch (e) { /* fall through */ }
		return data.exception || data.message || "";
	}

	// ------------------------------------------------------------------ guest mode (no account)
	// With "Sign-up not required" on, a guest's readers and progress live in this browser only.

	const GUEST_METHODS = new Set(["save_reader", "delete_reader", "get_progress", "start_session", "finish_session", "session_feedback"]);

	function guestDb() {
		if (!S.guestDb) {
			let stored = null;
			try { stored = JSON.parse(localStorage.getItem("es_reading_guest") || "null"); } catch (e) { /* storage unavailable */ }
			S.guestDb = Object.assign({ readers: [], sessions: [] }, stored || {});
		}
		return S.guestDb;
	}

	function guestSave() {
		try { localStorage.setItem("es_reading_guest", JSON.stringify(S.guestDb)); } catch (e) { /* kept in memory for this visit */ }
	}

	function guestApi(method, args) {
		const db = guestDb();
		const d = S.boot.defaults;
		const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
		const session = () => db.sessions.find((x) => x.name === args.session);
		if (method === "save_reader") {
			const data = JSON.parse(args.data);
			let reader = db.readers.find((r) => r.name === data.name);
			if (!reader) {
				if (db.readers.length >= d.max_readers) throw new Error(`You can have up to ${d.max_readers} readers.`);
				reader = { name: "GUEST-" + Date.now() };
				db.readers.push(reader);
			}
			const name = String(data.reader_name || "").replace(/[<>]/g, "").trim().slice(0, 40);
			if (!name) { if (!reader.reader_name) db.readers.pop(); throw new Error("Please give the reader a name."); }
			Object.assign(reader, {
				reader_name: name,
				avatar: String(data.avatar || "").slice(0, 8),
				voice_country: S.boot.countries.includes(data.voice_country) ? data.voice_country : "",
				voice_gender: ["Female", "Male"].includes(data.voice_gender) ? data.voice_gender : "",
				voice_name: String(data.voice_name || "").slice(0, 140),
				speech_rate: clamp(parseFloat(data.speech_rate) || d.speech_rate, 0.5, 1.5),
				lines_per_turn: clamp(parseInt(data.lines_per_turn, 10) || d.lines_per_turn, 1, 40),
				silence_seconds: clamp(parseInt(data.silence_seconds, 10) || d.silence_seconds, 2, 20),
				gap_percent: clamp(parseInt(data.gap_percent, 10) || d.gap_percent, 5, 300),
			});
			guestSave();
			return Object.assign({}, reader);
		}
		if (method === "delete_reader") {
			db.readers = db.readers.filter((r) => r.name !== args.name);
			db.sessions = db.sessions.filter((x) => x.reader !== args.name);
			guestSave();
			return { ok: true };
		}
		if (method === "get_progress") {
			return db.sessions.filter((x) => x.reader === args.reader && x.status === "Completed").reverse();
		}
		if (method === "start_session") {
			const row = { name: "GS-" + Date.now(), reader: args.reader, book: args.book, book_title: S.book ? S.book.title : args.book, mode: args.mode, status: "In Progress" };
			db.sessions.push(row);
			db.sessions = db.sessions.slice(-60);
			guestSave();
			return { name: row.name };
		}
		if (method === "finish_session") {
			const row = session();
			if (!row) throw new Error("That session was not found on this device.");
			const data = JSON.parse(args.data);
			const reader = db.readers.find((r) => r.name === row.reader) || {};
			const rs = Number(data.reader_seconds) || 0;
			const ns = Number(data.narrator_seconds) || 0;
			const words = Number(data.words_total) || 0;
			const helped = (data.helped_words || []).map(String);
			const gap = rs && ns ? ((rs - ns) / ns) * 100 : 0;
			const threshold = reader.gap_percent || d.gap_percent;
			Object.assign(row, {
				status: "Completed", completed_on: new Date().toISOString().slice(0, 10), reader_seconds: rs, narrator_seconds: ns,
				gap_percent: gap, words_total: words, words_helped: helped.length, helped_words: helped.join(", "),
				reader_wpm: words && rs ? (words / rs) * 60 : 0,
			});
			guestSave();
			return {
				name: row.name, reader_seconds: rs, narrator_seconds: ns, gap_percent: Math.round(gap * 10) / 10, threshold,
				suggest_practice: Boolean(rs && ns && gap > threshold), words_total: words, words_helped: helped.length,
				reader_wpm: Math.round(row.reader_wpm), narrator_wpm: words && ns ? Math.round((words / ns) * 60) : 0,
			};
		}
		if (method === "session_feedback") {
			const row = session() || {};
			const n = row.words_helped || 0;
			const feedback = row.mode === "Listen" ? "Lovely listening! Next time, try reading it together."
				: n === 0 ? "Wonderful reading! You read every word by yourself."
				: n <= 3 ? `Great reading! You only needed help with ${n} word${n === 1 ? "" : "s"}.`
				: "Well done for finishing! The tricky words get easier every time you practise.";
			return { feedback };
		}
	}

	async function api(method, args, post) {
		if (S.guest && GUEST_METHODS.has(method)) return guestApi(method, args || {});
		let url = "/api/method/es_reading.api." + method;
		const options = { headers: { "Accept": "application/json", "X-Frappe-CSRF-Token": CFG.csrf }, credentials: "same-origin" };
		if (args instanceof FormData) {
			options.method = "POST";
			options.body = args;
		} else if (post) {
			options.method = "POST";
			options.headers["Content-Type"] = "application/json";
			options.body = JSON.stringify(args || {});
		} else if (args) {
			url += "?" + new URLSearchParams(args).toString();
		}
		const response = await fetch(url, options);
		let data = {};
		try { data = await response.json(); } catch (e) { /* not JSON */ }
		if (!response.ok) {
			if (response.status === 401 || (response.status === 403 && data.session_expired)) {
				window.location.href = "/login?redirect-to=/reading";
			}
			throw new Error(serverMessage(data) || "Something went wrong (" + response.status + ").");
		}
		return data.message;
	}

	async function guard(fn) {
		try { return await fn(); } catch (e) { console.error(e); toast(e.message || String(e), 6000); }
	}

	function beep(freq, ms) {
		try {
			const Ctx = window.AudioContext || window.webkitAudioContext;
			beep.ctx = beep.ctx || new Ctx();
			const osc = beep.ctx.createOscillator();
			const gain = beep.ctx.createGain();
			osc.frequency.value = freq || 880;
			gain.gain.setValueAtTime(0.12, beep.ctx.currentTime);
			gain.gain.exponentialRampToValueAtTime(0.001, beep.ctx.currentTime + (ms || 180) / 1000);
			osc.connect(gain).connect(beep.ctx.destination);
			osc.start();
			osc.stop(beep.ctx.currentTime + (ms || 180) / 1000);
		} catch (e) { /* sound is optional */ }
	}

	function cheer(emoji) {
		const el = h("div", { class: "cheer", "aria-hidden": "true" }, emoji || "⭐");
		document.body.append(el);
		setTimeout(() => el.remove(), 950);
	}

	const wait = (ms) => new Promise((r) => setTimeout(r, ms));

	// ------------------------------------------------------------------ reader preferences

	function pref(key) {
		const r = S.reader || {};
		const d = S.boot.defaults;
		return r[key] || d[key];
	}

	// ------------------------------------------------------------------ voices

	const FEMALE = /female|woman|karen|catherine|samantha|victoria|allison|ava\b|susan|zira|hazel|kate|serena|moira|tessa|fiona|veena|natasha|libby|sonia|jenny|aria|michelle|molly|emma|olivia|isla|nicky|martha|stephanie|shelley|sandy|flo\b|kathy|joanna|kendra|kimberly|salli|ivy|amy|nicole|raveena|aditi|heera|linda|clara|neerja|leah|maisie|freya|annette|carly|elsie|joanne|kim\b|tina|matilda|zoe|sara|lisa|heather|emily|abbi|bella|hollie|olivia/i;
	const MALE = /\bmale|\bman\b|lee\b|daniel|alex|fred|tom\b|oliver|arthur|gordon|aaron|rishi|david|mark|george|james|ryan|guy\b|william|liam|thomas|brian|matthew|joey|justin|russell|eric|christopher|roger|steffan|prabhat|connor|mitchell|duncan|darren|neil|ken\b|tim\b|eddy|reed|rocko|ralph|albert|bruce|ravi|luke|noah|ethan|alfie|elliot|andrew|jacob|sean/i;

	function voiceGender(voice) {
		if (FEMALE.test(voice.name)) return "Female";
		if (MALE.test(voice.name)) return "Male";
		return "";
	}

	function voiceLang(voice) {
		return (voice.lang || "").replace("_", "-");
	}

	function loadVoices() {
		return new Promise((resolve) => {
			if (!synth) return resolve([]);
			const read = () => synth.getVoices().filter((v) => /^en/i.test(v.lang));
			const now = read();
			if (now.length) return resolve(now);
			let done = false;
			const finish = () => { if (!done) { done = true; resolve(read()); } };
			synth.addEventListener("voiceschanged", finish, { once: true });
			setTimeout(finish, 1500);
		});
	}

	/** Best voice on this device for the reader's country and gender. */
	function pickVoice(country, gender, name) {
		const voices = S.voices;
		if (!voices.length) return { voice: null, note: "This device has no reading voice, so the narrator is switched off." };
		if (name) {
			const exact = voices.find((v) => v.name === name);
			if (exact) return { voice: exact, note: "" };
		}
		const lang = LANG[country] || "en-AU";
		const local = voices.filter((v) => voiceLang(v).toLowerCase() === lang.toLowerCase());
		const byGender = (list) => list.filter((v) => voiceGender(v) === gender);
		const rank = (list) => list.slice().sort((a, b) => Number(b.localService) - Number(a.localService))[0];
		if (byGender(local).length) return { voice: rank(byGender(local)), note: "" };
		if (local.length) return { voice: rank(local), note: `This device has no ${gender.toLowerCase()} voice for ${country}, so it is using ${rank(local).name}.` };
		const any = byGender(voices).length ? rank(byGender(voices)) : voices[0];
		return { voice: any, note: `This device has no voice for ${country}, so it is using ${any.name}.` };
	}

	function currentVoice() {
		return pickVoice(pref("voice_country"), pref("voice_gender"), S.reader && S.reader.voice_name);
	}

	/** Speak one piece of text. Resolves with the seconds it took, or null if cancelled or unavailable. */
	function speak(text, opts) {
		opts = opts || {};
		return new Promise((resolve) => {
			const { voice } = currentVoice();
			if (!synth || !voice || !text.trim()) return resolve(null);
			const u = new SpeechSynthesisUtterance(text);
			u.voice = voice;
			u.lang = voiceLang(voice);
			u.rate = opts.rate || pref("speech_rate");
			let started = 0;
			let settled = false;
			const words = text.split(/\s+/).length;
			const finish = (ok) => {
				if (settled) return;
				settled = true;
				clearTimeout(guardTimer);
				speak.live.delete(u);
				resolve(ok && started ? (performance.now() - started) / 1000 : null);
			};
			// Some browsers never fire "end"; never let a turn hang on that.
			const guardTimer = setTimeout(() => finish(true), 4000 + (words * 900) / u.rate);
			u.onstart = () => { started = performance.now(); if (opts.onstart) opts.onstart(); };
			u.onboundary = (e) => { if (opts.onword && (!e.name || e.name === "word")) opts.onword(e.charIndex); };
			u.onend = () => finish(true);
			u.onerror = () => finish(false);
			speak.live.add(u); // keep a reference so the utterance is not garbage-collected mid-speech
			synth.speak(u);
		});
	}
	speak.live = new Set();

	function hush() {
		if (synth) synth.cancel();
	}

	// ------------------------------------------------------------------ words and matching

	function norm(word) {
		return word.toLowerCase().replace(/[’']/g, "").replace(/[^a-z0-9]+/g, "");
	}

	/** Break a line of text into tokens; each token lists the spoken words it contains. */
	function tokenize(text) {
		return text.split(/\s+/).filter(Boolean).map((raw) => ({
			text: raw,
			parts: raw.split(/[-–—/]+/).map(norm).filter(Boolean),
		}));
	}

	function levenshtein(a, b) {
		if (Math.abs(a.length - b.length) > 2) return 3;
		let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
		for (let i = 1; i <= a.length; i++) {
			const row = [i];
			for (let j = 1; j <= b.length; j++) {
				row[j] = Math.min(prev[j] + 1, row[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
			}
			prev = row;
		}
		return prev[b.length];
	}

	/** Rough "sounds like" key so that "kwenda" matches "quenda". */
	function soundKey(word) {
		let w = word.replace(/ph/g, "f").replace(/qu/g, "kw").replace(/ck/g, "k").replace(/x/g, "ks")
			.replace(/c(?=[eiy])/g, "s").replace(/c/g, "k").replace(/wh/g, "w").replace(/gh/g, "").replace(/z/g, "s");
		w = w[0] + w.slice(1).replace(/[aeiouyh]/g, "");
		return w.replace(/(.)\1+/g, "$1");
	}

	function similar(heard, expected) {
		if (heard === expected) return true;
		const shortest = Math.min(heard.length, expected.length);
		if (shortest < 3) return false;
		if (shortest >= 4 && (heard.startsWith(expected) || expected.startsWith(heard))) return true;
		const distance = levenshtein(heard, expected);
		if (expected.length >= 7 ? distance <= 2 : expected.length >= 4 && distance <= 1) return true;
		const key = soundKey(expected);
		return key.length >= 3 && key === soundKey(heard);
	}

	/** Move the pointer through the expected words as far as the heard words allow. */
	function advance(pointer, heard, expected) {
		for (const word of heard) {
			if (pointer >= expected.length) break;
			for (let k = 0; k <= 2 && pointer + k < expected.length; k++) {
				const target = expected[pointer + k].w;
				// The next word may be a near miss; skipping ahead needs an exact match on a real word.
				if (k === 0 ? similar(word, target) : word === target && target.length >= 3) {
					pointer += k + 1;
					break;
				}
			}
		}
		return pointer;
	}

	// ------------------------------------------------------------------ PDF

	function pdfLib() {
		const lib = window.pdfjsLib;
		if (lib && !lib.GlobalWorkerOptions.workerSrc) lib.GlobalWorkerOptions.workerSrc = CFG.pdfWorker;
		return lib;
	}

	async function openPdf(url) {
		if (!S.pdfCache[url]) S.pdfCache[url] = pdfLib().getDocument(url).promise;
		return S.pdfCache[url];
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
		let cover = null;
		try {
			const first = await pdf.getPage(1);
			const base = first.getViewport({ scale: 1 });
			const view = first.getViewport({ scale: 420 / base.width });
			const canvas = h("canvas", { width: Math.round(view.width), height: Math.round(view.height) });
			await first.render({ canvasContext: canvas.getContext("2d"), viewport: view }).promise;
			cover = canvas.toDataURL("image/jpeg", 0.8);
		} catch (e) { console.warn("cover", e); }
		return { pages, pageCount: pdf.numPages, cover };
	}

	async function prepareBook(book, status) {
		status("Reading the PDF…");
		const found = await extractPdf(book.pdf, (n, total) => status(`Reading page ${n} of ${total}…`));
		status("Saving…");
		return api("save_book_content", { book: book.name, pages: JSON.stringify(found.pages), page_count: found.pageCount, cover: found.cover }, true);
	}

	// ------------------------------------------------------------------ start-up and readers

	async function start() {
		S.boot = await api("get_bootstrap");
		S.guest = Boolean(S.boot.guest);
		if (S.guest) S.boot.readers = guestDb().readers;
		S.voices = await loadVoices();
		const remembered = localStorage.getItem("es_reading_reader");
		S.reader = S.boot.readers.find((r) => r.name === remembered) || null;
		if (S.reader) await viewLibrary(); else viewReaders();
	}

	function viewReaders() {
		leaveRun();
		const cards = S.boot.readers.map((r) =>
			h("button", { class: "card", onclick: () => chooseReader(r) }, h("span", { class: "avatar xl" }, r.avatar || "🦊"), h("span", { class: "title" }, r.reader_name))
		);
		cards.push(h("button", { class: "card", onclick: () => editReader(null) }, h("span", { class: "avatar xl" }, "＋"), h("span", { class: "title" }, "Add a reader")));
		show(
			h("div", { class: "bar" }, h("h1", {}, "ES Reading")),
			h("div", { class: "page" },
				h("div", { class: "hero" }, h("h2", {}, "Who's reading today?"), S.boot.readers.length ? null : h("p", {}, "Add each child once. A first name or nickname is all that's needed.")),
				h("div", { class: "readers" }, cards))
		);
	}

	async function chooseReader(reader) {
		S.reader = reader;
		localStorage.setItem("es_reading_reader", reader.name);
		await viewLibrary();
	}

	function editReader(reader) {
		const draft = Object.assign({ reader_name: "", avatar: AVATARS[Math.floor(Math.random() * AVATARS.length)] }, reader || {});
		const d = S.boot.defaults;
		const name = h("input", { type: "text", value: draft.reader_name, maxlength: 40, placeholder: "First name or nickname" });
		const picker = h("div", { class: "emoji-pick" });
		const paint = () => picker.replaceChildren(...AVATARS.map((a) => h("button", { type: "button", class: a === draft.avatar ? "on" : "", onclick: () => { draft.avatar = a; paint(); } }, a)));
		paint();

		const country = h("select", {}, S.boot.countries.map((c) => h("option", { value: c, selected: c === (draft.voice_country || d.voice_country) }, c)));
		const gender = h("select", {}, ["Female", "Male"].map((g) => h("option", { value: g, selected: g === (draft.voice_gender || d.voice_gender) }, g === "Female" ? "Female voice" : "Male voice")));
		const voice = h("select", {});
		const voiceNote = h("small", {});
		const fillVoices = () => {
			const lang = LANG[country.value].toLowerCase();
			const local = S.voices.filter((v) => voiceLang(v).toLowerCase() === lang);
			const list = local.length ? local : S.voices;
			voice.replaceChildren(h("option", { value: "" }, "Best match (automatic)"), ...list.map((v) => h("option", { value: v.name, selected: v.name === draft.voice_name }, `${v.name}${voiceGender(v) ? " · " + voiceGender(v).toLowerCase() : ""}`)));
			voiceNote.textContent = pickVoice(country.value, gender.value, voice.value).note || "Voices come from this device, so the choice can differ between a tablet and a computer.";
		};
		country.onchange = gender.onchange = () => { draft.voice_name = ""; fillVoices(); };
		voice.onchange = () => { draft.voice_name = voice.value; fillVoices(); };
		fillVoices();

		const rate = h("input", { type: "range", min: 0.6, max: 1.2, step: 0.05, value: draft.speech_rate || d.speech_rate });
		const lines = h("input", { type: "number", min: 1, max: 40, value: draft.lines_per_turn || d.lines_per_turn });
		const silence = h("input", { type: "number", min: 2, max: 20, value: draft.silence_seconds || d.silence_seconds });
		const gap = h("input", { type: "number", min: 5, max: 300, value: draft.gap_percent || d.gap_percent });
		const collect = () => ({
			name: reader && reader.name,
			reader_name: name.value,
			avatar: draft.avatar,
			voice_country: country.value,
			voice_gender: gender.value,
			voice_name: voice.value,
			speech_rate: rate.value,
			lines_per_turn: lines.value,
			silence_seconds: silence.value,
			gap_percent: gap.value,
		});
		const test = h("button", { type: "button", class: "btn small", onclick: async () => {
			const keep = S.reader;
			S.reader = collect(); // preview with the settings on screen
			hush();
			const spoken = await speak("Hello! I will be reading with you today.");
			S.reader = keep;
			if (spoken === null && !S.voices.length) toast("This device has no reading voice.");
		} }, "🔊 Try this voice");

		const body = h("div", {},
			h("label", { class: "field" }, h("span", {}, "Name"), name),
			h("div", { class: "field" }, h("span", {}, "Picture"), picker),
			h("div", { class: "two" }, h("label", { class: "field" }, h("span", {}, "Accent"), country), h("label", { class: "field" }, h("span", {}, "Voice"), gender)),
			h("label", { class: "field" }, h("span", {}, "Voice on this device"), voice, voiceNote),
			h("label", { class: "field" }, h("span", {}, "Narrator speed"), rate, h("small", {}, "Left is slower, right is faster.")),
			test,
			h("div", { class: "two" },
				h("label", { class: "field" }, h("span", {}, "Lines per turn"), lines),
				h("label", { class: "field" }, h("span", {}, "Help after a pause of (seconds)"), silence)),
			h("label", { class: "field" }, h("span", {}, "Suggest practice when reading takes this much longer than the narrator (%)"), gap)
		);
		modal(reader ? "Reader settings" : "Add a reader", body, (close) => [
			reader && h("button", { class: "btn danger small", onclick: () => {
				if (!window.confirm(`Remove ${reader.reader_name} and all of their reading history?`)) return;
				guard(async () => {
					await api("delete_reader", { name: reader.name }, true);
					S.boot.readers = S.boot.readers.filter((r) => r.name !== reader.name);
					S.reader = null;
					localStorage.removeItem("es_reading_reader");
					close();
					viewReaders();
				});
			} }, "Remove reader"),
			h("button", { class: "btn", onclick: close }, "Cancel"),
			h("button", { class: "btn primary", onclick: () => guard(async () => {
				const saved = await api("save_reader", { data: JSON.stringify(collect()) }, true);
				const at = S.boot.readers.findIndex((r) => r.name === saved.name);
				if (at >= 0) S.boot.readers[at] = saved; else S.boot.readers.push(saved);
				close();
				await chooseReader(saved);
			}) }, "Save"),
		]);
		if (!reader) name.focus();
	}

	// ------------------------------------------------------------------ library

	async function viewLibrary() {
		leaveRun();
		const [books, progress] = await Promise.all([api("get_books"), api("get_progress", { reader: S.reader.name })]);
		S.boot.books = books;
		S.progress = progress;
		const readBooks = new Set(progress.filter((p) => p.mode !== "Listen" && p.mode !== "Tricky Words").map((p) => p.book));
		const lib = S.boot.is_librarian;

		const cards = books.map((b) => {
			const ready = b.status === "Ready";
			const cover = h("span", { class: "cover", style: b.cover_image ? `background-image:url("${encodeURI(b.cover_image)}")` : "" }, b.cover_image ? "" : "📖");
			const meta = [b.reading_level, b.word_count ? `${b.word_count} words` : ""].filter(Boolean).join(" · ");
			const kids = [cover, h("span", { class: "title" }, b.title), meta && h("span", { class: "meta" }, meta), readBooks.has(b.name) && h("span", { class: "tick", title: "Read" }, "✓")];
			if (!lib) return h("button", { class: "card", onclick: () => openBook(b) }, kids);
			const status = !ready ? b.status + (b.note ? ": " + b.note : "") : b.published ? "" : "Hidden from families";
			return h("div", { class: "card" }, kids,
				status && h("span", { class: "status" }, status),
				h("div", { class: "row" },
					ready && h("button", { class: "btn small primary", onclick: () => openBook(b) }, "Open"),
					b.pdf && h("button", { class: "btn small", onclick: (e) => guard(async () => {
						const btn = e.currentTarget;
						btn.disabled = true;
						await prepareBook(b, (m) => (btn.textContent = m));
						await viewLibrary();
					}) }, ready ? "Re-scan" : "Prepare"),
					ready && h("button", { class: "btn small", onclick: () => guard(async () => { await api("set_book_published", { book: b.name, published: b.published ? 0 : 1 }, true); await viewLibrary(); }) }, b.published ? "Hide" : "Show"),
					h("button", { class: "btn small danger", onclick: () => window.confirm(`Delete "${b.title}" and its reading history?`) && guard(async () => { await api("delete_book", { book: b.name }, true); await viewLibrary(); }) }, "Delete")));
		});

		const notices = [];
		const v = currentVoice();
		if (v.note) notices.push(v.note);
		if (S.guest) notices.push(h("span", {}, "You're reading as a guest. Readers and progress are saved on this device only. ", h("a", { href: "/login?redirect-to=/reading" }, "Sign in"), " to keep them on your account."));
		if (!SR) notices.push("This browser can't listen to reading aloud. Chrome, Edge or Safari can. You can still read along and tap any word to hear it.");
		show(
			h("div", { class: "bar" },
				h("button", { class: "who btn small", onclick: viewReaders, title: "Change reader" }, h("span", { class: "avatar" }, S.reader.avatar || "🦊"), S.reader.reader_name),
				h("h1", {}, "Library"),
				lib && h("button", { class: "btn small sun", onclick: addBook }, "＋ Add a book"),
				h("button", { class: "btn small", onclick: viewProgress }, "📈 Progress"),
				h("button", { class: "btn small", onclick: () => editReader(S.reader) }, "⚙ Settings")),
			h("div", { class: "page" },
				notices.map((n) => h("div", { class: "notice" }, n)),
				cards.length ? h("div", { class: "grid" }, cards) : h("div", { class: "empty" }, lib ? "No books yet. Add a PDF to get started." : "No books in the library yet."))
		);
	}

	function addBook() {
		const title = h("input", { type: "text", maxlength: 140, placeholder: "Leave blank to use the file name" });
		const file = h("input", { type: "file", accept: "application/pdf,.pdf" });
		const status = h("p", { class: "meta" });
		modal("Add a book", h("div", {}, h("label", { class: "field" }, h("span", {}, "PDF file"), file), h("label", { class: "field" }, h("span", {}, "Title"), title), status), (close) => [
			h("button", { class: "btn", onclick: close }, "Cancel"),
			h("button", { class: "btn primary", onclick: (e) => guard(async () => {
				if (!file.files[0]) return toast("Choose a PDF first.");
				const btn = e.currentTarget;
				btn.disabled = true;
				try {
					status.textContent = "Uploading…";
					const form = new FormData();
					form.append("file", file.files[0]);
					form.append("title", title.value);
					const book = await api("create_book", form);
					const saved = await prepareBook(book, (m) => (status.textContent = m));
					close();
					toast(saved.status === "Ready" ? `Added: ${saved.lines} lines, ${saved.words} words.` : saved.note || saved.status, 6000);
					await viewLibrary();
				} finally { btn.disabled = false; }
			}) }, "Add"),
		]);
	}

	function viewProgress() {
		const rows = S.progress.map((p) => h("tr", {},
			h("td", {}, String(p.completed_on || "").slice(0, 10)),
			h("td", {}, h("b", {}, p.book_title), h("br"), MODE_LABEL[p.mode] || p.mode),
			h("td", {}, p.reader_seconds ? clock(p.reader_seconds) : "–", p.reader_wpm ? h("div", { class: "meta" }, `${Math.round(p.reader_wpm)} words/min`) : null),
			h("td", {}, p.words_helped ? `${p.words_helped}: ${p.helped_words}` : "none")));
		const body = rows.length
			? h("table", { class: "progress" }, h("thead", {}, h("tr", {}, ["Date", "Book", "Time", "Words helped"].map((t) => h("th", {}, t)))), h("tbody", {}, rows))
			: h("p", {}, "Nothing yet. Finished books will show up here.");
		modal(`${S.reader.reader_name}'s reading`, body, (close) => [h("button", { class: "btn primary", onclick: close }, "Close")]);
	}

	async function openBook(summary) {
		await guard(async () => {
			const book = await api("get_book", { name: summary.name });
			if (!book.lines.length) return toast("This book has no text to read yet.");
			S.book = book;
			const pick = (mode, cls, icon, title, sub) => h("button", { class: "btn " + cls, onclick: () => { close(); beginRun(mode); } }, h("span", { style: "font-size:28px" }, icon), h("span", {}, title, h("small", {}, sub)));
			const close = modal(book.title, h("div", {},
				book.summary && h("p", {}, book.summary),
				h("div", { class: "modes" },
					pick("Read Together", "primary big", "👂🎤", "Read together", "Listen to a few lines, then read them back."),
					pick("Re-read", "", "📖", "I'll read it myself", "Read aloud with help when you get stuck."),
					pick("Tricky Words", "", "🧩", "Tricky words", "Practise the long and difficult words."),
					pick("Listen", "", "👂", "Just listen", "Hear the whole story read aloud."))),
				(c) => [h("button", { class: "btn", onclick: c }, "Back")]);
		});
	}

	// ------------------------------------------------------------------ building the reading run

	const SENTENCE_END = /[.!?]["'”’)\]]*$/;

	/** Group the book's lines into turns: N lines, never across a page, ending on a full sentence where possible. */
	function buildChunks(lines, perTurn) {
		const chunks = [];
		let i = 0;
		while (i < lines.length) {
			const page = lines[i].page;
			let end = i;
			while (end < lines.length && lines[end].page === page && end - i < perTurn) end++;
			let extra = 0;
			while (extra < 3 && end < lines.length && lines[end].page === page && !SENTENCE_END.test(lines[end - 1].text)) { end++; extra++; }
			let rest = end;
			while (rest < lines.length && lines[rest].page === page) rest++;
			if (rest - end <= 2) end = rest; // don't leave a one- or two-line turn at the bottom of a page
			chunks.push(makeChunk(lines.slice(i, end), page));
			i = end;
		}
		return chunks;
	}

	function makeChunk(lines, page) {
		const tokens = [];
		lines.forEach((line, lineIdx) => tokenize(line.text).forEach((t) => tokens.push(Object.assign(t, { line: lineIdx, helps: 0 }))));
		const expected = [];
		tokens.forEach((t, idx) => t.parts.forEach((w) => expected.push({ w, tok: idx })));
		return { page, lines, tokens, expected, words: tokens.filter((t) => t.parts.length).length };
	}

	function leaveRun() {
		document.body.classList.remove("in-session");
		if (S.run) {
			S.run.dead = true;
			if (S.run.listener) S.run.listener.stop();
			clearInterval(S.run.ticker);
			S.run = null;
		}
		hush();
	}

	async function beginRun(mode) {
		leaveRun();
		beep(660, 60); // unlock audio inside the tap that started the run
		if (mode === "Tricky Words") return beginTricky();
		const run = (S.run = {
			mode,
			chunks: buildChunks(S.book.lines, pref("lines_per_turn")),
			index: 0,
			readerMs: 0,
			narratorSec: 0,
			narratedWords: 0,
			helped: [],
			listening: Boolean(SR) && mode !== "Listen",
			listeningUsed: false,
			paused: false,
			phase: "",
			session: null,
		});
		run.totalWords = run.chunks.reduce((n, c) => n + c.words, 0);
		renderReadView(run);
		try {
			run.session = (await api("start_session", { reader: S.reader.name, book: S.book.name, mode }, true)).name;
			try { S.pdf = S.book.pdf ? await openPdf(S.book.pdf) : null; } catch (e) { S.pdf = null; }
			for (run.index = 0; run.index < run.chunks.length && !run.dead; run.index++) {
				await playChunk(run, run.chunks[run.index]);
			}
			if (!run.dead) await finishRun(run);
		} catch (e) {
			if (!run.dead) { console.error(e); toast(e.message || String(e), 6000); }
		}
	}

	// ------------------------------------------------------------------ reading view

	function renderReadView(run) {
		document.body.classList.add("in-session");
		const ui = (run.ui = {});
		ui.pageLabel = h("span", { class: "clock" });
		ui.meter = h("i");
		ui.clock = h("span", { class: "clock", title: "Your reading time" }, "⏱ 0 s");
		ui.pagewrap = h("div", { class: "pagewrap" });
		ui.sheet = h("div", { class: "sheet" }, ui.pagewrap);
		ui.phase = h("div", { class: "phase" });
		ui.text = h("div", { class: "text" });
		ui.pause = h("button", { class: "btn", onclick: () => togglePause(run) }, "⏸ Pause");
		ui.again = h("button", { class: "btn", onclick: () => run.replay && run.replay() }, "🔁 Again");
		ui.help = h("button", { class: "btn sun", onclick: () => run.helpNow && run.helpNow() }, "💡 Help me");
		ui.done = h("button", { class: "btn primary", onclick: () => run.endTurn && run.endTurn() }, "✓ I've read it");
		ui.mic = h("button", { class: "btn small", onclick: () => toggleMic(run) });
		show(
			h("div", { class: "bar" },
				h("button", { class: "btn icon-btn", title: "Back to the library", "aria-label": "Back to the library", onclick: () => { if (window.confirm("Stop reading and go back to the library?")) guard(viewLibrary); } }, "✕"),
				h("h1", {}, S.book.title),
				h("div", { class: "meter", title: "How far through the book" }, ui.meter),
				ui.pageLabel,
				ui.clock),
			h("div", { class: "read" }, ui.sheet,
				h("div", { class: "panel" }, ui.phase, ui.text,
					h("div", { class: "controls" }, ui.pause, ui.again, ui.help, ui.done, h("span", { class: "spacer" }), ui.mic)))
		);
		paintMic(run);
		run.ticker = setInterval(() => tick(run), 250);
	}

	function paintMic(run) {
		const ui = run.ui;
		ui.mic.hidden = !SR || run.mode === "Listen";
		ui.mic.textContent = run.listening ? "🎤 Listening on" : "🎤 Listening off";
	}

	function toggleMic(run) {
		run.listening = !run.listening;
		paintMic(run);
		if (run.phase === "turn") {
			if (run.listening) startListening(run); else if (run.listener) run.listener.stop();
			paintPhase(run);
		}
	}

	function paintPhase(run) {
		const ui = run.ui;
		const turn = run.phase === "turn";
		ui.phase.className = "phase " + (turn ? "turn" : "listen");
		const sub = turn
			? run.listening ? "Read the words out loud. I'm listening and will help if you get stuck." : "Read the words out loud. Tap any word to hear it, then tap “I've read it”."
			: "Listen and follow the yellow word.";
		ui.phase.replaceChildren(h("span", { class: "dot" }, turn ? "🎤" : "👂"), h("span", {}, turn ? "Your turn!" : "Listen…", h("small", {}, run.paused ? "Paused" : sub)));
		ui.again.hidden = turn;
		ui.help.hidden = !turn;
		ui.done.hidden = !turn;
		ui.pause.textContent = run.paused ? "▶ Carry on" : "⏸ Pause";
	}

	async function renderChunk(run, chunk) {
		const ui = run.ui;
		ui.text.replaceChildren();
		chunk.tokens.forEach((t, idx) => {
			t.el = h("span", { class: "w", tabindex: t.parts.length ? 0 : null, role: t.parts.length ? "button" : null, onclick: () => tapWord(run, chunk, idx) }, t.text);
			t.el.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); tapWord(run, chunk, idx); } });
			ui.text.append(t.el, " ");
		});
		ui.text.scrollTop = 0;
		ui.meter.style.width = Math.round((run.index / run.chunks.length) * 100) + "%";
		ui.pageLabel.textContent = `Page ${chunk.page}` + (S.book.page_count ? ` of ${S.book.page_count}` : "");
		await renderPage(run, chunk);
	}

	async function renderPage(run, chunk) {
		const ui = run.ui;
		if (!S.pdf) {
			ui.pagewrap.replaceChildren(h("div", { class: "nopdf" }, "📖"));
			return;
		}
		if (ui.shownPage !== chunk.page) {
			const page = await S.pdf.getPage(chunk.page);
			const base = page.getViewport({ scale: 1 });
			const cssWidth = Math.min(Math.max(ui.sheet.clientWidth - 32, 280), 900);
			const view = page.getViewport({ scale: (cssWidth / base.width) * Math.min(window.devicePixelRatio || 1, 2) });
			const canvas = h("canvas", { width: Math.round(view.width), height: Math.round(view.height) });
			await page.render({ canvasContext: canvas.getContext("2d"), viewport: view }).promise;
			if (run.dead) return;
			ui.pagewrap.style.width = cssWidth + "px";
			ui.pagewrap.replaceChildren(canvas);
			ui.shownPage = chunk.page;
		}
		ui.pagewrap.querySelectorAll(".hl").forEach((el) => el.remove());
		chunk.lines.forEach((line) => {
			line.hl = null;
			if (!line.w || !line.h) return;
			line.hl = h("div", { class: "hl", style: `left:${line.x * 100}%;top:${line.y * 100}%;width:${line.w * 100}%;height:${line.h * 100}%` });
			ui.pagewrap.append(line.hl);
		});
		const first = chunk.lines.find((l) => l.hl);
		if (first) ui.sheet.scrollTo({ top: Math.max(0, first.hl.offsetTop - 40), behavior: "smooth" });
	}

	function markLine(chunk, lineIdx) {
		chunk.lines.forEach((line, i) => line.hl && line.hl.classList.toggle("active", i === lineIdx));
	}

	function markToken(chunk, idx, cls) {
		chunk.tokens.forEach((t) => t.el.classList.remove(cls));
		const t = chunk.tokens[idx];
		if (!t) return;
		t.el.classList.add(cls);
		markLine(chunk, t.line);
		const box = t.el.parentElement;
		if (t.el.offsetTop < box.scrollTop || t.el.offsetTop + t.el.offsetHeight > box.scrollTop + box.clientHeight - 20) {
			box.scrollTo({ top: Math.max(0, t.el.offsetTop - 60), behavior: "smooth" });
		}
	}

	// ------------------------------------------------------------------ one turn: listen, then read

	async function playChunk(run, chunk) {
		await renderChunk(run, chunk);
		if (run.dead) return;
		if (run.mode !== "Re-read") {
			run.phase = "listen";
			paintPhase(run);
			await narrate(run, chunk);
			if (run.dead) return;
		}
		if (run.mode !== "Listen") {
			run.phase = "turn";
			paintPhase(run);
			beep(880, 160);
			await childTurn(run, chunk);
			if (run.dead) return;
			cheer(run.index + 1 === run.chunks.length ? "🎉" : "⭐");
			await wait(700);
		}
	}

	function spokenForm(token) {
		return token.text.replace(/[—–]/g, ", ").replace(/_+/g, " ").trim();
	}

	/** Read the chunk aloud sentence by sentence, lighting each word as it is spoken. */
	async function narrate(run, chunk) {
		const sentences = [];
		let from = 0;
		chunk.tokens.forEach((t, idx) => {
			if (SENTENCE_END.test(t.text) || idx === chunk.tokens.length - 1) {
				sentences.push([from, idx + 1]);
				from = idx + 1;
			}
		});
		let s = 0;
		let replay = false;
		run.replay = () => { replay = true; hush(); };
		while (s < sentences.length && !run.dead) {
			while (run.paused && !run.dead) await wait(200);
			if (run.dead) break;
			if (replay) { replay = false; s = 0; chunk.tokens.forEach((t) => t.el.classList.remove("speaking", "now")); }
			const [a, b] = sentences[s];
			let text = "";
			const starts = [];
			for (let i = a; i < b; i++) {
				const piece = spokenForm(chunk.tokens[i]);
				starts.push([text.length, i]);
				if (piece) text += piece + " ";
			}
			const light = (charIndex) => {
				let hit = starts[0][1];
				for (const [at, idx] of starts) { if (at <= charIndex) hit = idx; else break; }
				markToken(chunk, hit, "now");
			};
			const seconds = await speak(text, {
				onstart: () => { for (let i = a; i < b; i++) chunk.tokens[i].el.classList.add("speaking"); markLine(chunk, chunk.tokens[a].line); },
				onword: light,
			});
			for (let i = a; i < b; i++) chunk.tokens[i].el.classList.remove("speaking", "now");
			if (run.dead) break;
			if (run.paused || replay) continue; // interrupted: say this sentence again
			if (seconds === null && !currentVoice().voice) break; // no voice on this device
			if (seconds !== null) {
				run.narratorSec += seconds;
				run.narratedWords += chunk.tokens.slice(a, b).filter((t) => t.parts.length).length;
			}
			s++;
		}
		run.replay = null;
		markLine(chunk, -1);
	}

	function makeListener(lang, onWords, onBlocked) {
		let rec = null;
		let active = false;
		const open = () => {
			rec = new SR();
			rec.lang = lang;
			rec.continuous = true;
			rec.interimResults = true;
			rec.onresult = (e) => {
				let transcript = "";
				for (let i = 0; i < e.results.length; i++) transcript += " " + e.results[i][0].transcript;
				onWords(transcript.split(/[\s-]+/).map(norm).filter(Boolean));
			};
			rec.onerror = (e) => {
				if (e.error === "not-allowed" || e.error === "service-not-allowed" || e.error === "audio-capture") { active = false; onBlocked(e.error); }
			};
			rec.onend = () => { if (active) setTimeout(() => active && open(), 150); };
			onWords(null); // a fresh recognition session starts with an empty transcript
			try { rec.start(); } catch (e) { /* already started */ }
		};
		return {
			start() { if (!active) { active = true; open(); } },
			stop() { active = false; if (rec) { rec.onend = null; try { rec.abort(); } catch (e) { /* not running */ } } },
		};
	}

	function startListening(run) {
		if (run.listener) run.listener.stop();
		const turn = run.turn;
		if (!turn || !run.listening || run.paused) return;
		const lang = currentVoice().voice ? voiceLang(currentVoice().voice) : LANG[pref("voice_country")] || "en-AU";
		run.listener = makeListener(
			LANG[pref("voice_country")] || lang,
			(heard) => {
				if (heard === null) { turn.anchor = turn.pointer; return; }
				run.listeningUsed = true;
				const next = advance(turn.anchor, heard, turn.chunk.expected);
				if (next > turn.pointer) setPointer(run, next);
			},
			() => {
				run.listening = false;
				paintMic(run);
				paintPhase(run);
				toast("The microphone is blocked, so I can't listen. You can still read and tap words for help.", 7000);
			}
		);
		run.listener.start();
	}

	function setPointer(run, pointer) {
		const turn = run.turn;
		const chunk = turn.chunk;
		turn.pointer = pointer;
		turn.lastMove = performance.now();
		const current = pointer < chunk.expected.length ? chunk.expected[pointer].tok : chunk.tokens.length;
		chunk.tokens.forEach((t, idx) => t.el.classList.toggle("done", idx < current));
		if (pointer >= chunk.expected.length) return turn.finish();
		markToken(chunk, current, "cur");
	}

	/** The child reads the chunk. Resolves when every word is read or "I've read it" is tapped. */
	function childTurn(run, chunk) {
		return new Promise((resolve) => {
			const turn = (run.turn = { chunk, pointer: 0, anchor: 0, lastMove: performance.now(), started: performance.now(), busy: false, over: false });
			turn.finish = () => {
				if (turn.over) return;
				turn.over = true;
				if (run.listener) run.listener.stop();
				if (!run.paused) run.readerMs += performance.now() - turn.started;
				chunk.tokens.forEach((t) => { t.el.classList.remove("cur"); t.el.classList.add("done"); });
				markLine(chunk, -1);
				run.turn = run.helpNow = run.endTurn = null;
				resolve();
			};
			run.endTurn = turn.finish;
			run.helpNow = () => helpWord(run, chunk, chunk.expected[turn.pointer].tok);
			if (!chunk.expected.length) return turn.finish();
			setPointer(run, 0);
			startListening(run);
		});
	}

	/** Say a word for the child and count it as helped. A second help on the same word moves past it. */
	async function helpWord(run, chunk, tokIdx) {
		const turn = run.turn;
		const token = chunk.tokens[tokIdx];
		if (!turn || turn.busy || turn.over || !token || !token.parts.length) return;
		turn.busy = true;
		if (run.listener) run.listener.stop(); // don't let the microphone hear the narrator
		token.helps++;
		token.el.classList.add("helped");
		const word = token.text.replace(/^[^A-Za-z0-9]+|[^A-Za-z0-9]+$/g, "");
		if (!run.helped.some((w) => w.toLowerCase() === word.toLowerCase())) run.helped.push(word);
		hush();
		await speak(word, { rate: Math.max(0.6, pref("speech_rate") - 0.15) });
		if (run.dead || turn.over) return;
		turn.busy = false;
		const current = chunk.expected[turn.pointer].tok;
		if (tokIdx === current && token.helps >= 2) {
			let next = turn.pointer;
			while (next < chunk.expected.length && chunk.expected[next].tok === tokIdx) next++;
			setPointer(run, next);
		} else {
			turn.lastMove = performance.now();
		}
		if (!turn.over) startListening(run);
	}

	function tapWord(run, chunk, idx) {
		if (run.phase === "turn" && run.turn && !run.paused) helpWord(run, chunk, idx);
	}

	function togglePause(run) {
		run.paused = !run.paused;
		const turn = run.turn;
		if (run.paused) {
			hush();
			if (run.listener) run.listener.stop();
			if (turn) run.readerMs += performance.now() - turn.started;
		} else if (turn) {
			turn.started = turn.lastMove = performance.now();
			startListening(run);
		}
		paintPhase(run);
	}

	function tick(run) {
		if (run.dead) return;
		const turn = run.turn;
		const live = turn && !run.paused ? performance.now() - turn.started : 0;
		run.ui.clock.textContent = "⏱ " + clock((run.readerMs + live) / 1000);
		if (!turn || run.paused || turn.busy || turn.over || !run.listening) return;
		if (performance.now() - turn.lastMove > pref("silence_seconds") * 1000) {
			helpWord(run, turn.chunk, turn.chunk.expected[turn.pointer].tok);
		}
	}

	// ------------------------------------------------------------------ results

	function narratorPace() {
		const stored = parseFloat(localStorage.getItem("es_reading_wpm") || "");
		return stored > 40 ? stored : 165 * pref("speech_rate");
	}

	async function finishRun(run) {
		clearInterval(run.ticker);
		if (run.narratedWords >= 20 && run.narratorSec > 5) {
			localStorage.setItem("es_reading_wpm", String((run.narratedWords / run.narratorSec) * 60));
		}
		// Words the narrator did not read aloud this time are estimated from its measured pace.
		const missing = Math.max(0, run.totalWords - run.narratedWords);
		const narratorSeconds = run.narratorSec + (missing / narratorPace()) * 60;
		S.lastHelped = run.helped.slice();
		const result = await api("finish_session", {
			session: run.session,
			data: JSON.stringify({
				reader_seconds: run.mode === "Listen" ? 0 : run.readerMs / 1000,
				narrator_seconds: narratorSeconds,
				words_total: run.totalWords,
				helped_words: run.helped,
				listening_used: run.listeningUsed ? 1 : 0,
			}),
		}, true);
		viewResults(run, result);
	}

	function practiceOptions(primary) {
		const opt = (mode, icon, title, sub, cls) => h("button", { class: "btn " + (cls || ""), onclick: () => beginRun(mode) }, h("span", { style: "font-size:28px" }, icon), h("span", {}, title, h("small", {}, sub)));
		return h("div", { class: "options modes" },
			opt("Re-read", "📖", "Read it again", "Read the story out loud once more.", primary ? "primary big" : ""),
			opt("Tricky Words", "🧩", "Practise the tricky words", "Hear and say the long and difficult words.", primary ? "sun" : ""),
			opt("Listen", "👂", "Listen to the whole story", "Sit back and hear it read aloud.", ""),
			h("button", { class: "btn", onclick: () => guard(viewLibrary) }, "📚 Back to the library"));
	}

	function viewResults(run, r) {
		leaveRun();
		const share = r.words_total ? r.words_helped / r.words_total : 0;
		const stars = run.mode === "Listen" ? 0 : share <= 0.02 ? 3 : share <= 0.08 ? 2 : 1;
		const feedback = h("div", { class: "feedback" }, "…");
		const longest = Math.max(r.reader_seconds, r.narrator_seconds, 1);
		const timed = run.mode !== "Listen" && r.reader_seconds > 0;
		const gapLine = !timed ? "" : r.gap_percent > 0
			? `You took ${Math.round(r.gap_percent)}% longer than the narrator.`
			: "You read it as quickly as the narrator!";
		show(
			h("div", { class: "bar" }, h("span", { class: "avatar" }, S.reader.avatar || "🦊"), h("h1", {}, S.book.title)),
			h("div", { class: "page" }, h("div", { class: "result" },
				h("div", { class: "hero" },
					stars ? h("div", { class: "stars", "aria-label": `${stars} out of 3 stars` }, "⭐".repeat(stars)) : null,
					h("h2", {}, run.mode === "Listen" ? "The end!" : r.suggest_practice ? "You finished! Let's make it even smoother." : "Brilliant reading!"),
					gapLine && h("p", {}, gapLine)),
				timed && h("div", { class: "times" },
					h("div", { class: "box" }, h("b", {}, clock(r.reader_seconds)), h("span", {}, `Your time · ${r.reader_wpm} words a minute`)),
					h("div", { class: "box" }, h("b", {}, clock(r.narrator_seconds)), h("span", {}, `Narrator's time · ${r.narrator_wpm} words a minute`))),
				timed && h("div", { class: "bars" },
					h("div", { class: "barrow you" }, h("span", {}, "You"), h("i", { style: `width:${(r.reader_seconds / longest) * 80}%` })),
					h("div", { class: "barrow" }, h("span", {}, "Narrator"), h("i", { style: `width:${(r.narrator_seconds / longest) * 80}%` }))),
				timed && h("p", {}, r.words_helped ? `Words I helped with: ${run.helped.join(", ")}` : "You didn't need help with any words."),
				feedback,
				r.suggest_practice && h("h3", {}, "What would you like to do next?"),
				practiceOptions(r.suggest_practice)))
		);
		api("session_feedback", { session: r.name }, true)
			.then((f) => (feedback.textContent = f.feedback))
			.catch(() => feedback.remove());
	}

	// ------------------------------------------------------------------ tricky words

	function trickyList() {
		const seen = new Set();
		const list = [];
		const add = (word, say, meaning) => {
			const key = norm(word);
			if (!key || seen.has(key)) return;
			seen.add(key);
			list.push({ word, say: say || "", meaning: meaning || "" });
		};
		const known = {};
		S.book.tricky_words.forEach((t) => (known[norm(t.word)] = t));
		S.lastHelped.forEach((w) => { const k = known[norm(w)]; add(w, k && k.say, k && k.meaning); });
		S.book.tricky_words.forEach((t) => add(t.word, t.say, t.meaning));
		const minLength = S.boot.defaults.tricky_word_length;
		const long = [];
		S.book.lines.forEach((line) => tokenize(line.text).forEach((t) => {
			const word = t.text.replace(/^[^A-Za-z]+|[^A-Za-z]+$/g, "");
			if (/^[A-Za-z’']+$/.test(word) && word.length >= minLength) long.push(word);
		}));
		long.sort((a, b) => b.length - a.length).forEach((w) => add(w.toLowerCase()));
		return list.slice(0, 15);
	}

	async function beginTricky() {
		const words = trickyList();
		if (!words.length) { toast("This book has no tricky words. Well done!"); return guard(viewLibrary); }
		const run = (S.run = { mode: "Tricky Words", dead: false, listener: null });
		document.body.classList.add("in-session");
		const session = await guard(() => api("start_session", { reader: S.reader.name, book: S.book.name, mode: "Tricky Words" }, true));
		const started = performance.now();
		const stage = h("div", { class: "result" });
		const meter = h("i");
		show(
			h("div", { class: "bar" },
				h("button", { class: "btn icon-btn", "aria-label": "Back to the library", onclick: () => guard(viewLibrary) }, "✕"),
				h("h1", {}, "Tricky words"), h("div", { class: "meter" }, meter)),
			h("div", { class: "page" }, stage)
		);
		for (let i = 0; i < words.length && !run.dead; i++) {
			meter.style.width = Math.round((i / words.length) * 100) + "%";
			await practiseWord(run, words[i], stage);
		}
		if (run.dead) return;
		leaveRun();
		if (session) {
			await guard(() => api("finish_session", { session: session.name, data: JSON.stringify({ reader_seconds: (performance.now() - started) / 1000, narrator_seconds: 0, words_total: words.length, helped_words: [] }) }, true));
		}
		show(
			h("div", { class: "bar" }, h("span", { class: "avatar" }, S.reader.avatar || "🦊"), h("h1", {}, S.book.title)),
			h("div", { class: "page" }, h("div", { class: "result" },
				h("div", { class: "hero" }, h("div", { class: "stars" }, "🧩⭐"), h("h2", {}, `You practised ${words.length} tricky words!`), h("p", {}, "Now try reading the story again.")),
				practiceOptions(true)))
		);
	}

	function practiseWord(run, item, stage) {
		return new Promise((resolve) => {
			let over = false;
			const status = h("p", { class: "meta" }, SR ? "Listen, then say the word." : "Listen, say the word, then tap Next.");
			const done = (said) => {
				if (over) return;
				over = true;
				if (run.listener) run.listener.stop();
				hush();
				if (said) { cheer("⭐"); setTimeout(resolve, 800); } else resolve();
			};
			const listen = () => {
				if (!SR || over || run.dead) return;
				if (run.listener) run.listener.stop();
				const targets = tokenize(item.word).flatMap((t) => t.parts);
				run.listener = makeListener(LANG[pref("voice_country")] || "en-AU", (heard) => {
					if (heard && targets.every((t) => heard.some((w) => similar(w, t)))) done(true);
				}, () => (status.textContent = "Say the word, then tap Next."));
				run.listener.start();
			};
			const hear = async () => {
				if (run.listener) run.listener.stop();
				hush();
				await speak(item.word, { rate: Math.max(0.6, pref("speech_rate") - 0.15) });
				listen();
			};
			stage.replaceChildren(
				h("div", { class: "bigword" }, item.word),
				item.say && h("div", { class: "say" }, item.say),
				item.meaning && h("div", { class: "meaning" }, item.meaning),
				status,
				h("div", { class: "controls", style: "justify-content:center;border:0" },
					h("button", { class: "btn big sun", onclick: hear }, "🔊 Hear it"),
					h("button", { class: "btn big primary", onclick: () => done(false) }, "Next ➜"))
			);
			hear();
		});
	}

	// ------------------------------------------------------------------ site menu

	(function siteMenu() {
		const bar = document.querySelector(".sitebar");
		if (!bar) return;
		const toggle = bar.querySelector(".sitebar-toggle");
		toggle.addEventListener("click", () => toggle.setAttribute("aria-expanded", String(bar.classList.toggle("open"))));
		const drops = [...bar.querySelectorAll("details.drop")];
		drops.forEach((d) => d.addEventListener("toggle", () => d.open && drops.forEach((o) => o !== d && (o.open = false))));
		document.addEventListener("click", (e) => drops.forEach((d) => d.open && !d.contains(e.target) && (d.open = false)));
		document.addEventListener("keydown", (e) => e.key === "Escape" && drops.forEach((d) => (d.open = false)));
	})();

	// ------------------------------------------------------------------ go

	window.addEventListener("pagehide", hush);
	window.ESReading = { tokenize, advance, similar, buildChunks, extractPdf }; // exposed for testing
	start().catch((e) => {
		console.error(e);
		show(h("div", { class: "page" }, h("div", { class: "hero" }, h("h2", {}, "ES Reading couldn't start"), h("p", {}, e.message || String(e)))));
	});
})();

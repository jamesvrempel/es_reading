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
		"Questions": "Questions about the story",
		"Practice Test": "Practice test",
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

	function modal(title, body, actions, wide) {
		const veil = h("div", { class: "veil" });
		const close = () => veil.remove();
		veil.append(h("div", { class: "modal" + (wide ? " wide" : ""), role: "dialog", "aria-label": title }, h("h2", {}, title), body, h("div", { class: "actions" }, actions(close))));
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

	const GUEST_METHODS = new Set(["save_reader", "delete_reader", "get_progress", "start_session", "finish_session", "session_feedback", "save_progress", "get_resume", "practise_words", "save_quiz"]);

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
				reading_age: parseInt(data.reading_age, 10) ? clamp(parseInt(data.reading_age, 10), 4, 18) : 0,
				syllable_hint: data.syllable_hint === undefined ? 1 : Number(data.syllable_hint) ? 1 : 0,
				record_reading: Number(data.record_reading) ? 1 : 0,
				classes: [],
				display_prefs: typeof data.display_prefs === "string" ? data.display_prefs.slice(0, 300) : "{}",
				word_bank: reader.word_bank || {},
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
				status: "Completed", completed_on: localDay(0), reader_seconds: rs, narrator_seconds: ns,
				gap_percent: gap, words_total: words, words_helped: helped.length, helped_words: helped.join(", "),
				reader_wpm: words && rs ? (words / rs) * 60 : 0,
			});
			reader.word_bank = reader.word_bank || {};
			helped.forEach((word) => {
				const key = norm(word);
				if (!key) return;
				const entry = (reader.word_bank[key] = reader.word_bank[key] || { w: word.toLowerCase(), h: 0, r: 0 });
				entry.h += 1;
				entry.r = 0;
				entry.last = localDay(0);
			});
			guestSave();
			return {
				reader: reader.name ? Object.assign({}, reader) : null,
				name: row.name, reader_seconds: rs, narrator_seconds: ns, gap_percent: Math.round(gap * 10) / 10, threshold,
				suggest_practice: Boolean(rs && ns && gap > threshold), words_total: words, words_helped: helped.length,
				reader_wpm: Math.round(row.reader_wpm), narrator_wpm: words && ns ? Math.round((words / ns) * 60) : 0,
			};
		}
		if (method === "save_quiz") {
			const row = session();
			if (row) { row.quiz_total = Number(args.total) || 0; row.quiz_correct = Number(args.correct) || 0; guestSave(); }
			return { ok: true };
		}
		if (method === "save_progress") {
			const row = session();
			if (row && row.status === "In Progress") {
				const data = JSON.parse(args.data);
				Object.assign(row, { lines_completed: Number(data.lines_completed) || 0, reader_seconds: Number(data.reader_seconds) || 0, narrator_seconds: Number(data.narrator_seconds) || 0, helped_list: (data.helped_words || []).map(String) });
				guestSave();
			}
			return { ok: true };
		}
		if (method === "get_resume") {
			const row = db.sessions.filter((x) => x.reader === args.reader && x.book === args.book && x.status === "In Progress" && x.lines_completed > 0 && (x.mode === "Read Together" || x.mode === "Re-read")).pop();
			return row ? { session: row.name, mode: row.mode, lines_completed: row.lines_completed, reader_seconds: row.reader_seconds, narrator_seconds: row.narrator_seconds, helped_words: row.helped_list || [] } : null;
		}
		if (method === "practise_words") {
			const reader = db.readers.find((r) => r.name === args.reader);
			if (!reader) throw new Error("That reader was not found on this device.");
			reader.word_bank = reader.word_bank || {};
			JSON.parse(args.results).forEach((item) => {
				const entry = reader.word_bank[norm(item.word)];
				if (entry) { entry.r = item.right ? Math.min((entry.r || 0) + 1, 3) : 0; entry.last = localDay(0); }
			});
			guestSave();
			return Object.assign({}, reader);
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
		if (S.audio) S.audio.cancel();
	}

	/** Hash of a sentence; must match es_reading/narration.py text_key. */
	function textKey(text) {
		const t = text.replace(/\s+/g, " ").trim().toLowerCase();
		let out = "";
		for (const seed of [0x811c9dc5, 0x01000193]) {
			let hash = seed;
			for (let i = 0; i < t.length; i++) hash = Math.imul(hash ^ t.charCodeAt(i), 0x01000193) >>> 0;
			out += hash.toString(16).padStart(8, "0");
		}
		return out;
	}

	/** Play one recorded sentence. Resolves with the seconds it took, or null if stopped or it failed. */
	function playClip(clip, opts, length) {
		return new Promise((resolve) => {
			const audio = new Audio(clip.u);
			const rate = Math.max(0.5, Math.min(1.5, Number(pref("speech_rate")) || 1));
			let started = 0;
			let settled = false;
			const finish = (ok) => {
				if (settled) return;
				settled = true;
				audio.pause();
				if (S.audio && S.audio.el === audio) S.audio = null;
				resolve(ok && started ? (performance.now() - started) / 1000 : null);
			};
			audio.playbackRate = rate;
			audio.preservesPitch = true;
			audio.onplaying = () => { if (!started) { started = performance.now(); if (opts.onstart) opts.onstart(); } };
			// No word timings come with the recording, so the highlight follows the playback position.
			audio.ontimeupdate = () => { if (opts.onword && audio.duration) opts.onword(Math.floor((audio.currentTime / audio.duration) * length)); };
			audio.onended = () => finish(true);
			audio.onerror = () => finish(false);
			S.audio = { el: audio, cancel: () => finish(false) };
			audio.play().catch(() => finish(false));
		});
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

	const { openPdf, extractPdf, renderPageOne } = window.ESReadingScan;

	async function prepareBook(book, status) {
		status("Reading the PDF…");
		const found = await extractPdf(book.pdf, (n, total) => status(`Reading page ${n} of ${total}…`));
		status("Saving…");
		return api("save_book_content", { book: book.name, pages: JSON.stringify(found.pages), page_count: found.pageCount, cover: found.cover }, true);
	}

	// ------------------------------------------------------------------ reader extras: display, level, stats, word bank

	function localDay(daysAgo) {
		const d = new Date();
		d.setDate(d.getDate() - (daysAgo || 0));
		return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
	}

	function displayPrefs(reader) {
		try { return JSON.parse((reader || S.reader || {}).display_prefs || "{}") || {}; } catch (e) { return {}; }
	}

	/** Apply the reader's font, text size, spacing and background to the reading panel. */
	function applyDisplay() {
		const d = displayPrefs();
		const data = document.body.dataset;
		data.font = d.font || "default";
		data.size = d.size || "normal";
		data.spacing = d.spacing || "normal";
		data.bg = d.background || "cream";
	}

	function updateReader(reader) {
		if (!reader || !reader.name) return;
		S.reader = reader;
		const at = S.boot.readers.findIndex((r) => r.name === reader.name);
		if (at >= 0) S.boot.readers[at] = reader;
		applyDisplay();
	}

	/** Words the reader has needed help with: still learning, and mastered (said right three times running). */
	function wordBank() {
		const bank = (S.reader && S.reader.word_bank) || {};
		const all = Object.keys(bank).map((key) => Object.assign({ key }, bank[key])).filter((w) => w.w);
		all.sort((a, b) => String(b.last || "").localeCompare(String(a.last || "")));
		return { learning: all.filter((w) => (w.r || 0) < 3), mastered: all.filter((w) => (w.r || 0) >= 3) };
	}

	function bookAge(book) {
		const match = /(\d+)/.exec(book.reading_level || "");
		return match ? parseInt(match[1], 10) : null;
	}

	/** The reader's level as an age: set by a grown-up, or worked out from books read comfortably. */
	function readerLevel() {
		if (S.reader.reading_age) return S.reader.reading_age;
		const ages = {};
		(S.boot.books || []).forEach((b) => (ages[b.name] = bookAge(b)));
		const comfortable = (S.progress || []).filter((p) => (p.mode === "Read Together" || p.mode === "Re-read") && p.words_total > 0 && ages[p.book] && p.words_helped / p.words_total <= 0.06).slice(0, 5);
		if (comfortable.length < 2) return null;
		return Math.round(comfortable.reduce((n, p) => n + ages[p.book], 0) / comfortable.length);
	}

	function bookFit(book) {
		const level = readerLevel();
		const age = bookAge(book);
		if (!level || !age) return "";
		return Math.abs(age - level) <= 1 ? "right" : age > level ? "stretch" : "easy";
	}

	function readerStats() {
		const progress = S.progress || [];
		const reads = progress.filter((p) => p.mode === "Read Together" || p.mode === "Re-read");
		const days = [...new Set(progress.map((p) => String(p.completed_on || "").slice(0, 10)).filter(Boolean))].sort();
		const has = new Set(days);
		let streak = 0;
		const from = has.has(localDay(0)) ? 0 : has.has(localDay(1)) ? 1 : -1;
		if (from >= 0) while (has.has(localDay(from + streak))) streak++;
		let best = 0;
		let run = 0;
		days.forEach((day, i) => {
			const prev = i ? new Date(days[i - 1] + "T12:00:00") : null;
			run = prev && Math.round((new Date(day + "T12:00:00") - prev) / 86400000) === 1 ? run + 1 : 1;
			best = Math.max(best, run);
		});
		const books = new Set(reads.map((p) => p.book)).size;
		const mastered = wordBank().mastered.length;
		const badges = [
			["first", "📗", "First book", books >= 1],
			["five", "📚", "Bookworm: 5 books", books >= 5],
			["ten", "🏅", "Super reader: 10 books", books >= 10],
			["twentyfive", "🏆", "Library legend: 25 books", books >= 25],
			["streak3", "🔥", "3 days in a row", best >= 3],
			["streak7", "🌟", "7 days in a row", best >= 7],
			["nohelp", "💪", "A book with no help", reads.some((p) => p.reader_seconds > 0 && !p.words_helped)],
			["speedy", "⚡", "As quick as the narrator", reads.some((p) => p.reader_seconds > 0 && p.narrator_seconds > 0 && p.gap_percent <= 0)],
			["tricky", "🧩", "Tricky word practice", progress.some((p) => p.mode === "Tricky Words")],
			["wizard", "🧙", "Word wizard: 10 words mastered", mastered >= 10],
			["quiz", "🤔", "Every question right", progress.some((p) => p.quiz_total > 0 && p.quiz_correct === p.quiz_total)],
		].map(([id, icon, title, earned]) => ({ id, icon, title, earned }));
		return { books, streak, mastered, reads, badges, minutes: Math.round(reads.reduce((n, p) => n + (p.reader_seconds || 0), 0) / 60) };
	}

	/** Split a word into rough syllables for a hint. Uses the book's own tricky-word notes when it has them. */
	function syllables(word) {
		const known = S.book && (S.book.tricky_words || []).find((t) => norm(t.word) === norm(word));
		if (known && known.say && known.say.includes("-")) return known.say.split("-").filter(Boolean);
		const w = word.replace(/[^A-Za-z’']/g, "");
		if (w.length < 5) return [w];
		// Work in sound units so that pairs like "th" and "sh" are never pulled apart.
		const units = w.match(/th|sh|ch|ph|wh|ck|qu|[a-z’']/gi) || [w];
		const vowel = (u) => /^[aeiouy]$/i.test(u || "");
		const parts = [];
		let cur = "";
		for (let i = 0; i < units.length; i++) {
			cur += units[i];
			if (!vowel(units[i]) || vowel(units[i + 1])) continue;
			let run = 0; // consonant units before the next vowel
			while (i + 1 + run < units.length && !vowel(units[i + 1 + run])) run++;
			if (i + 1 + run >= units.length) continue; // no vowel left: the rest stays with this piece
			if (run >= 2) cur += units[++i]; // split a cluster after its first consonant: "but-ter", "grand-fa"
			if (run >= 3 && /^[nrlm]$/i.test(units[i]) && !/^[lr]$/i.test(units[i + 2])) cur += units[++i]; // "grand-fa", but "ter-fly"
			parts.push(cur);
			cur = "";
		}
		if (cur) parts.push(cur);
		// an ending with no vowel sound of its own ("-de", "-s") belongs with the piece before it
		while (parts.length > 1 && /^[^aeiouy]*e?$/i.test(parts[parts.length - 1])) {
			const last = parts.pop();
			parts[parts.length - 1] += last;
		}
		return parts;
	}

	function svg(tag, attrs, ...kids) {
		const el = document.createElementNS("http://www.w3.org/2000/svg", tag);
		Object.entries(attrs || {}).forEach(([k, v]) => el.setAttribute(k, v));
		kids.flat().forEach((kid) => kid != null && el.append(kid.nodeType ? kid : document.createTextNode(String(kid))));
		return el;
	}

	/** A small chart of one number per session, oldest on the left. */
	function chart(values, kind, colour) {
		const W = 320, H = 110, pad = 14;
		const max = Math.max(...values, 1);
		const x = (i) => (values.length === 1 ? W / 2 : pad + (i * (W - 2 * pad)) / (values.length - 1));
		const y = (v) => H - pad - (v / max) * (H - 2 * pad - 12);
		const marks = kind === "bar"
			? values.map((v, i) => svg("rect", { x: x(i) - 5, y: y(v), width: 10, height: Math.max(H - pad - y(v), 1), rx: 3, fill: colour }))
			: [svg("polyline", { points: values.map((v, i) => `${x(i)},${y(v)}`).join(" "), fill: "none", stroke: colour, "stroke-width": 3, "stroke-linejoin": "round", "stroke-linecap": "round" }),
				...values.map((v, i) => svg("circle", { cx: x(i), cy: y(v), r: 4, fill: colour }))];
		const last = values[values.length - 1];
		return svg("svg", { viewBox: `0 0 ${W} ${H}`, class: "chart", role: "img", "aria-label": `Latest ${Math.round(last)}, highest ${Math.round(max)}` },
			svg("line", { x1: pad, y1: H - pad, x2: W - pad, y2: H - pad, stroke: "#e6dcc8", "stroke-width": 2 }), marks,
			svg("text", { x: W - pad, y: 12, "text-anchor": "end", class: "chart-label" }, `latest ${Math.round(last)} · best ${Math.round(max)}`));
	}

	// ------------------------------------------------------------------ start-up and readers

	async function start() {
		S.boot = await api("get_bootstrap");
		S.guest = Boolean(S.boot.guest);
		if (S.guest) S.boot.readers = guestDb().readers;
		S.voices = await loadVoices();
		const remembered = localStorage.getItem("es_reading_reader");
		S.reader = S.boot.readers.find((r) => r.name === remembered) || null;
		applyDisplay();
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
				h("div", { class: "readers" }, cards),
				S.boot.weekly_email && S.boot.weekly_email.offered && h("p", { class: "empty", style: "padding:28px 0 0" },
					h("button", { class: "btn small", onclick: () => guard(async () => {
						S.boot.weekly_email.on = (await api("set_weekly_email", { on: S.boot.weekly_email.on ? 0 : 1 }, true)).on;
						viewReaders();
					}) }, S.boot.weekly_email.on ? "✉ Weekly email summary: on" : "✉ Weekly email summary: off")))
		);
	}

	async function chooseReader(reader) {
		S.reader = reader;
		localStorage.setItem("es_reading_reader", reader.name);
		applyDisplay();
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
		const dp = displayPrefs(draft);
		const choose = (options, current) => h("select", {}, options.map(([value, label]) => h("option", { value, selected: value === current }, label)));
		const level = h("input", { type: "number", min: 4, max: 18, value: draft.reading_age || "", placeholder: "Worked out automatically" });
		const hint = h("input", { type: "checkbox", checked: reader ? Boolean(draft.syllable_hint) : true });
		const record = h("input", { type: "checkbox", checked: Boolean(draft.record_reading) });
		const code = h("input", { type: "text", maxlength: 8, placeholder: "6-letter code from the teacher", style: "text-transform:uppercase" });
		const classBox = h("div", {});
		const paintClasses = (list) => classBox.replaceChildren(...(list || []).map((c) => h("p", { class: "meta" }, `In ${c.class_name} `,
			h("button", { type: "button", class: "btn small", onclick: () => guard(async () => { const r = await api("leave_class", { reader: reader.name, name: c.name }, true); updateReader(r); paintClasses(r.classes); }) }, "Leave"))));
		paintClasses(draft.classes);
		const font = choose([["default", "Rounded (standard)"], ["lexend", "Lexend (wider letters)"]], dp.font || "default");
		const size = choose([["normal", "Normal"], ["large", "Large"], ["xlarge", "Extra large"]], dp.size || "normal");
		const spacing = choose([["normal", "Normal"], ["wide", "Wide"]], dp.spacing || "normal");
		const background = choose([["cream", "Cream"], ["white", "White"], ["blue", "Pale blue"], ["yellow", "Pale yellow"], ["dark", "Dark"]], dp.background || "cream");
		const collect = () => ({
			reading_age: level.value || 0,
			syllable_hint: hint.checked ? 1 : 0,
			record_reading: record.checked ? 1 : 0,
			display_prefs: JSON.stringify({ font: font.value, size: size.value, spacing: spacing.value, background: background.value }),
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
			h("label", { class: "field" }, h("span", {}, "Suggest practice when reading takes this much longer than the narrator (%)"), gap),
			h("label", { class: "field" }, h("span", {}, "Reading level (age)"), level, h("small", {}, "Optional. Books near this level are marked “Just right”. Leave it blank and the app works it out from the books read.")),
			h("label", { class: "field check" }, hint, h("span", {}, "Show the syllables first when stuck on a word")),
			h("label", { class: "field check" }, record, h("span", {}, "Record my reading so I can hear it afterwards", h("small", {}, "Recordings stay on this device and are gone when you leave the results page. On some tablets recording stops the app from listening; turn this off if that happens."))),
			reader && !S.guest && h("div", {}, h("h3", {}, "Class"), classBox,
				h("label", { class: "field" }, h("span", {}, "Join a class"), code, h("small", {}, "Joining shares this reader's name and reading progress with the class teacher.")),
				h("button", { type: "button", class: "btn small", onclick: () => guard(async () => {
					const r = await api("join_class", { reader: reader.name, code: code.value }, true);
					updateReader(r);
					paintClasses(r.classes);
					code.value = "";
					toast("Joined the class.");
				}) }, "Join")),
			h("h3", {}, "How the words look"),
			h("div", { class: "two" }, h("label", { class: "field" }, h("span", {}, "Lettering"), font), h("label", { class: "field" }, h("span", {}, "Text size"), size)),
			h("div", { class: "two" }, h("label", { class: "field" }, h("span", {}, "Spacing"), spacing), h("label", { class: "field" }, h("span", {}, "Background"), background))
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
		clearRecordings();
		const [books, progress] = await Promise.all([api("get_books"), api("get_progress", { reader: S.reader.name })]);
		S.boot.books = books;
		S.progress = progress;
		S.filter = S.filter || { text: "", shelf: "" };
		const readBooks = new Set(progress.filter((p) => p.mode === "Read Together" || p.mode === "Re-read" || p.mode === "Practice Test").map((p) => p.book));
		const lib = S.boot.is_librarian;
		const stats = readerStats();
		const shelves = [...new Set(books.map((b) => (b.shelf || "").trim()).filter(Boolean))].sort((x, y) => x.localeCompare(y));
		if (!shelves.includes(S.filter.shelf)) S.filter.shelf = "";
		const fitRank = { right: 0, "": 1, stretch: 2, easy: 3 };
		const assigned = new Set((S.reader.classes || []).flatMap((c) => c.books));

		const card = (b) => {
			const ready = b.status === "Ready";
			const fit = ready ? bookFit(b) : "";
			const cover = h("span", { class: "cover", style: b.cover_image ? `background-image:url("${encodeURI(b.cover_image)}")` : "" }, b.cover_image ? "" : "📖");
			const meta = [b.reading_level, b.word_count ? `${b.word_count} words` : ""].filter(Boolean).join(" · ");
			const kids = [cover, h("span", { class: "title" }, b.title), meta && h("span", { class: "meta" }, meta),
				assigned.has(b.name) && h("span", { class: "fit class" }, "From your class"),
				b.question_count > 0 && h("span", { class: "fit" }, `❓ ${Math.min(b.question_count, 6)} questions`),
				fit === "right" && h("span", { class: "fit right" }, "Just right for you"),
				fit === "stretch" && h("span", { class: "fit" }, "A challenge"),
				readBooks.has(b.name) && h("span", { class: "tick", title: "Read" }, "✓")];
			if (!lib) return h("button", { class: "card", onclick: () => openBook(b) }, kids);
			const status = !ready ? b.status + (b.note ? ": " + b.note : "") : b.published ? "" : "Hidden from families";
			return h("div", { class: "card" }, kids,
				b.shelf && h("span", { class: "meta" }, "Shelf: " + b.shelf),
				status && h("span", { class: "status" }, status),
				h("div", { class: "row" },
					ready && h("button", { class: "btn small primary", onclick: () => openBook(b) }, "Open"),
					h("button", { class: "btn small", onclick: () => manageBook(b, shelves) }, "Manage")));
		};

		const grid = h("div", { class: "grid" });
		const none = h("div", { class: "empty" });
		const paint = () => {
			const text = S.filter.text.trim().toLowerCase();
			const shown = books
				.filter((b) => !S.filter.shelf || (b.shelf || "").trim() === S.filter.shelf)
				.filter((b) => !text || [b.title, b.shelf, b.reading_level, b.summary].some((v) => String(v || "").toLowerCase().includes(text)))
				.map((b, i) => ({ b, i, rank: assigned.has(b.name) && !readBooks.has(b.name) ? -1 : fitRank[b.status === "Ready" ? bookFit(b) : ""] }))
				.sort((x, y) => x.rank - y.rank || x.i - y.i)
				.map((x) => card(x.b));
			grid.replaceChildren(...shown);
			none.textContent = shown.length ? "" : books.length ? "No books match. Try another word or shelf." : lib ? "No books yet. Add a PDF to get started." : "No books in the library yet.";
			none.hidden = Boolean(shown.length);
		};
		const chips = h("div", { class: "chips" });
		const paintChips = () => chips.replaceChildren(...["", ...shelves].map((name) =>
			h("button", { class: "chip" + (S.filter.shelf === name ? " on" : ""), onclick: () => { S.filter.shelf = name; paintChips(); paint(); } }, name || "All books")));
		const search = h("input", { type: "search", class: "search", placeholder: "Find a book…", "aria-label": "Find a book", value: S.filter.text });
		search.oninput = () => { S.filter.text = search.value; paint(); };
		paintChips();
		paint();

		const notices = [];
		const v = currentVoice();
		if (v.note) notices.push(v.note);
		if (S.guest) notices.push(h("span", {}, "You're reading as a guest. Readers and progress are saved on this device only. ", h("a", { href: "/login?redirect-to=/reading" }, "Sign in"), " to keep them on your account."));
		if (!SR) notices.push("This browser can't listen to reading aloud. Chrome, Edge or Safari can. You can still read along and tap any word to hear it.");
		const learning = wordBank().learning.length;
		const progressLabel = stats.books || stats.streak ? `⭐ ${stats.books} ${stats.books === 1 ? "book" : "books"}` + (stats.streak > 1 ? ` · 🔥 ${stats.streak} days` : "") : "📈 Progress";
		const wanted = new URLSearchParams(window.location.search).get("manage");
		if (wanted && lib && !S.managedFromLink) {
			S.managedFromLink = true;
			const target = books.find((b) => b.name === wanted);
			if (target) setTimeout(() => manageBook(target, shelves), 0);
		}
		show(
			h("div", { class: "bar" },
				h("button", { class: "who btn small", onclick: viewReaders, title: "Change reader" }, h("span", { class: "avatar" }, S.reader.avatar || "🦊"), S.reader.reader_name),
				h("h1", {}, "Library"),
				lib && h("button", { class: "btn small sun", onclick: addBook }, "＋ Add a book"),
				S.boot.is_teacher && h("button", { class: "btn small", onclick: viewClasses }, "🏫 Classes"),
				h("button", { class: "btn small", onclick: viewWords, title: "My words" }, "🧠 My words" + (learning ? ` (${learning})` : "")),
				h("button", { class: "btn small", onclick: viewProgress, title: "Progress" }, progressLabel),
				h("button", { class: "btn small", onclick: () => editReader(S.reader) }, "⚙ Settings")),
			h("div", { class: "page" },
				notices.map((n) => h("div", { class: "notice" }, n)),
				(books.length > 6 || shelves.length > 0) && h("div", { class: "toolbar" }, search, shelves.length ? chips : null),
				grid, none)
		);
	}

	/** Librarian: everything that can be done to one book. */
	function manageBook(b, shelves) {
		const ready = b.status === "Ready";
		const status = h("p", { class: "meta" });
		const act = (label, fn, cls) => h("button", { class: "btn " + (cls || ""), onclick: (e) => fn(e.currentTarget) }, label);
		const close = modal(b.title, h("div", { class: "modes" },
			b.pdf && act(ready ? "🔄 Re-scan the PDF" : "✨ Prepare this book", (btn) => guard(async () => {
				btn.disabled = true;
				await prepareBook(b, (m) => (status.textContent = m));
				close();
				await viewLibrary();
			})),
			act("🖼 Picture", () => { close(); bookPicture(b); }),
			ready && S.boot.narration_enabled && act("🎙 Narrator's voice", () => { close(); bookNarration(b); }),
			act("✏️ Title, shelf and level", () => { close(); bookDetails(b, shelves); }),
			ready && act("📄 Choose the pages to read", () => { close(); bookPages(b); }),
			ready && act(b.published ? "🙈 Hide from families" : "👀 Show to families", () => guard(async () => { await api("set_book_published", { book: b.name, published: b.published ? 0 : 1 }, true); close(); await viewLibrary(); })),
			act("🗑 Delete", () => window.confirm(`Delete "${b.title}" and its reading history?`) && guard(async () => { await api("delete_book", { book: b.name }, true); close(); await viewLibrary(); }), "danger"),
			status), (c) => [h("button", { class: "btn", onclick: c }, "Close")]);
	}

	function bookDetails(b, shelves) {
		const title = h("input", { type: "text", maxlength: 140, value: b.title || "" });
		const shelf = h("input", { type: "text", maxlength: 60, value: b.shelf || "", list: "es-shelves", placeholder: "For example Animals or Level 2" });
		const level = h("input", { type: "text", maxlength: 60, value: b.reading_level || "", placeholder: "For example Age 7-8" });
		const summary = h("input", { type: "text", maxlength: 300, value: b.summary || "" });
		const body = h("div", {},
			h("label", { class: "field" }, h("span", {}, "Title"), title),
			h("label", { class: "field" }, h("span", {}, "Shelf"), shelf, h("datalist", { id: "es-shelves" }, (shelves || []).map((name) => h("option", { value: name }))), h("small", {}, "Books with the same shelf are grouped together in the library.")),
			h("label", { class: "field" }, h("span", {}, "Reading level"), level, h("small", {}, "The first number is used as the age when matching books to readers.")),
			h("label", { class: "field" }, h("span", {}, "One-line summary"), summary));
		modal("Book details", body, (close) => [
			h("button", { class: "btn", onclick: close }, "Cancel"),
			h("button", { class: "btn primary", onclick: () => guard(async () => {
				await api("update_book", { book: b.name, data: JSON.stringify({ title: title.value, shelf: shelf.value, reading_level: level.value, summary: summary.value }) }, true);
				close();
				await viewLibrary();
			}) }, "Save"),
		]);
	}

	async function bookPages(b) {
		const book = await guard(() => api("get_book", { name: b.name }));
		if (!book) return;
		const boxes = (book.page_info || []).map((page) => {
			const box = h("input", { type: "checkbox", checked: page.read, "data-page": page.page });
			return h("label", { class: "field check" }, box, h("span", {}, `Page ${page.page}`, h("small", {}, `${page.words} words · “${page.first}…”`)));
		});
		modal("Pages to read", h("div", {}, h("p", { class: "meta" }, "Untick pages that should not be read aloud, such as questions or answers."), boxes), (close) => [
			h("button", { class: "btn", onclick: close }, "Cancel"),
			h("button", { class: "btn primary", onclick: () => guard(async () => {
				const skip = boxes.map((label) => label.querySelector("input")).filter((box) => !box.checked).map((box) => Number(box.dataset.page));
				const saved = await api("set_book_pages", { book: b.name, skip_pages: JSON.stringify(skip) }, true);
				close();
				toast(`Saved: ${saved.lines} lines, ${saved.words} words to read.`);
				await viewLibrary();
			}) }, "Save"),
		]);
	}

	// ------------------------------------------------------------------ word bank

	function viewWords() {
		const { learning, mastered } = wordBank();
		const say = (w) => { hush(); speak(w.w, { rate: Math.max(0.6, pref("speech_rate") - 0.15) }); };
		const chip = (w, cls) => h("button", { class: "chip " + cls, title: "Tap to hear it", onclick: () => say(w) }, w.w, w.h > 1 ? h("small", {}, ` ×${w.h}`) : null);
		const body = h("div", {},
			h("h3", {}, "Words to practise"),
			learning.length ? h("div", { class: "chips" }, learning.map((w) => chip(w, ""))) : h("p", { class: "meta" }, "Nothing to practise. Words you need help with while reading will appear here."),
			h("h3", { style: "margin-top:18px" }, "Words you know now ⭐"),
			mastered.length ? h("div", { class: "chips" }, mastered.map((w) => chip(w, "on"))) : h("p", { class: "meta" }, "Say a word correctly three times in practice and it moves here."));
		modal(`${S.reader.reader_name}'s words`, body, (close) => [
			h("button", { class: "btn", onclick: close }, "Close"),
			learning.length ? h("button", { class: "btn primary", onclick: () => { close(); beginWordPractice(learning.slice(0, 10)); } }, "🎤 Practise these words") : null,
		]);
	}

	async function beginWordPractice(list) {
		leaveRun();
		beep(660, 60);
		const run = (S.run = { mode: "Word Bank", dead: false, listener: null });
		document.body.classList.add("in-session");
		const stage = h("div", { class: "result" });
		const meter = h("i");
		show(
			h("div", { class: "bar" },
				h("button", { class: "btn icon-btn", "aria-label": "Back to the library", onclick: () => guard(viewLibrary) }, "✕"),
				h("h1", {}, "My words"), h("div", { class: "meter" }, meter)),
			h("div", { class: "page" }, stage)
		);
		const before = new Set(wordBank().mastered.map((w) => w.key));
		const results = [];
		for (let i = 0; i < list.length && !run.dead; i++) {
			meter.style.width = Math.round((i / list.length) * 100) + "%";
			const said = await practiseWord(run, { word: list[i].w, say: syllables(list[i].w).length > 1 ? syllables(list[i].w).join("-") : "", meaning: "" }, stage);
			if (run.dead) return;
			results.push({ word: list[i].w, right: Boolean(said) });
		}
		leaveRun();
		const reader = await guard(() => api("practise_words", { reader: S.reader.name, results: JSON.stringify(results) }, true));
		updateReader(reader);
		const right = results.filter((r) => r.right).length;
		const fresh = wordBank().mastered.filter((w) => !before.has(w.key)).map((w) => w.w);
		show(
			h("div", { class: "bar" }, h("span", { class: "avatar" }, S.reader.avatar || "🦊"), h("h1", {}, "My words")),
			h("div", { class: "page" }, h("div", { class: "result" },
				h("div", { class: "hero" }, h("div", { class: "stars" }, "🧠⭐"), h("h2", {}, `You said ${right} of ${results.length} words!`),
					fresh.length ? h("p", {}, `You know ${fresh.length === 1 ? "this word" : "these words"} now: ${fresh.join(", ")}`) : h("p", {}, "Say a word correctly three times and it joins the words you know.")),
				h("div", { class: "options modes" }, h("button", { class: "btn primary big", onclick: () => guard(viewLibrary) }, "📚 Back to the library"))))
		);
	}

	/** Librarian: give a book its own picture, or go back to the picture of page 1. */
	function bookPicture(book) {
		const file = h("input", { type: "file", accept: "image/jpeg,image/png,image/webp,image/gif" });
		const preview = h("span", { class: "cover", style: (book.cover_image ? `background-image:url("${encodeURI(book.cover_image)}");` : "") + "max-width:180px;margin:0 auto 12px" }, book.cover_image ? "" : "📖");
		const status = h("p", { class: "meta" }, book.custom_cover ? "This book is using your own picture." : "This book is using a picture of page 1.");
		file.onchange = () => {
			if (!file.files[0]) return;
			preview.style.backgroundImage = `url("${URL.createObjectURL(file.files[0])}")`;
			preview.textContent = "";
		};
		const body = h("div", {}, preview, status,
			h("label", { class: "field" }, h("span", {}, "Choose a picture"), file, h("small", {}, "JPG, PNG, WebP or GIF, up to 5 MB. A tall picture (3 wide by 4 high) fits the card best.")));
		modal(`Picture for “${book.title}”`, body, (close) => [
			book.custom_cover && book.pdf && h("button", { class: "btn small", onclick: (e) => guard(async () => {
				e.currentTarget.disabled = true;
				status.textContent = "Making a picture of page 1…";
				const cover = await renderPageOne(await openPdf(book.pdf));
				if (!cover) throw new Error("Page 1 could not be drawn.");
				await api("set_book_cover", { book: book.name, page_cover: cover }, true);
				close();
				await viewLibrary();
			}) }, "Use page 1 again"),
			h("button", { class: "btn", onclick: close }, "Cancel"),
			h("button", { class: "btn primary", onclick: (e) => guard(async () => {
				if (!file.files[0]) return toast("Choose a picture first.");
				const btn = e.currentTarget;
				btn.disabled = true;
				try {
					const form = new FormData();
					form.append("file", file.files[0]);
					form.append("book", book.name);
					await api("set_book_cover", form);
					close();
					await viewLibrary();
				} finally { btn.disabled = false; }
			}) }, "Save picture"),
		]);
	}

	function addBook() {
		const title = h("input", { type: "text", maxlength: 140, placeholder: "Leave blank to use the file's name" });
		const file = h("input", { type: "file", accept: "application/pdf,.pdf,application/epub+zip,.epub" });
		const text = h("textarea", { rows: 9, placeholder: "Type or paste the story here. Leave a blank line between paragraphs." });
		const kind = h("select", {}, h("option", { value: "file" }, "A PDF or EPUB file"), h("option", { value: "text" }, "Text I type or paste"));
		const fileField = h("label", { class: "field" }, h("span", {}, "File"), file, h("small", {}, "PDFs keep their pictures and layout. EPUBs are read as text only."));
		const textField = h("label", { class: "field", hidden: true }, h("span", {}, "Text"), text);
		kind.onchange = () => { fileField.hidden = kind.value !== "file"; textField.hidden = kind.value !== "text"; };
		const status = h("p", { class: "meta" });
		modal("Add a book", h("div", {}, h("label", { class: "field" }, h("span", {}, "Add from"), kind), fileField, textField, h("label", { class: "field" }, h("span", {}, "Title"), title), status), (close) => [
			h("button", { class: "btn", onclick: close }, "Cancel"),
			h("button", { class: "btn primary", onclick: (e) => guard(async () => {
				if (kind.value === "file" && !file.files[0]) return toast("Choose a file first.");
				if (kind.value === "text" && !text.value.trim()) return toast("Type or paste some text first.");
				if (kind.value === "text" && !title.value.trim()) return toast("Give the book a title.");
				const btn = e.currentTarget;
				btn.disabled = true;
				try {
					let saved;
					if (kind.value === "text") {
						status.textContent = "Saving…";
						saved = await api("create_text_book", { title: title.value, text: text.value }, true);
					} else {
						status.textContent = "Uploading…";
						const form = new FormData();
						form.append("file", file.files[0]);
						form.append("title", title.value);
						const book = await api("create_book", form);
						saved = book.pdf ? await prepareBook(book, (m) => (status.textContent = m)) : book;
					}
					close();
					toast(saved.status === "Ready" ? `Added: ${saved.lines} lines, ${saved.words} words.` : saved.note || saved.status, 6000);
					await viewLibrary();
				} finally { btn.disabled = false; }
			}) }, "Add"),
		]);
	}

	// ------------------------------------------------------------------ narrator's recorded voice (librarian)

	async function bookNarration(b) {
		const [info, book] = await Promise.all([guard(() => api("narration_status", { book: b.name })), guard(() => api("get_book", { name: b.name }))]);
		if (!info || !book) return;
		const sentences = bookSentences(book.lines);
		const characters = sentences.reduce((n, t) => n + t.length, 0);
		const recorded = {};
		info.recorded.forEach((r) => (recorded[r.voice] = r));
		const d = S.boot.defaults;
		const boxes = info.voices.map((v) => {
			const done = recorded[v.voice];
			const box = h("input", { type: "checkbox", checked: v.country === d.voice_country && v.gender === d.voice_gender, "data-country": v.country, "data-gender": v.gender });
			const note = done ? `${done.status}: ${done.clip_count} of ${sentences.length} sentences` + (done.note ? ` (${done.note})` : "") : "not recorded";
			return h("label", { class: "field check" }, box, h("span", {}, `${v.country} · ${v.gender.toLowerCase()}`, h("small", {}, note)));
		});
		const minutes = Math.max(1, Math.round((sentences.length * 3.5) / 60));
		modal("Narrator's voice", h("div", {},
			h("p", { class: "meta" }, `This book has ${sentences.length} sentences, about ${characters.toLocaleString()} characters for each voice. Recording takes about ${minutes} ${minutes === 1 ? "minute" : "minutes"} per voice and happens in the background.`),
			h("p", { class: "meta" }, "Readers hear the recording that matches their accent and voice setting. Sentences without a recording, and single words, are read by the device's own voice."),
			boxes), (close) => [
			h("button", { class: "btn", onclick: close }, "Close"),
			h("button", { class: "btn primary", onclick: () => guard(async () => {
				const voices = boxes.map((label) => label.querySelector("input")).filter((box) => box.checked).map((box) => [box.dataset.country, box.dataset.gender]);
				if (!voices.length) return toast("Tick at least one voice.");
				const queued = await api("record_narration", { book: b.name, voices: JSON.stringify(voices), sentences: JSON.stringify(sentences) }, true);
				close();
				toast(`Recording ${queued.queued.length} ${queued.queued.length === 1 ? "voice" : "voices"} in the background. Open this again to see progress.`, 7000);
			}) }, "🎙 Record"),
		], true);
	}

	// ------------------------------------------------------------------ classes

	/** Teacher: list classes and make new ones. */
	async function viewClasses() {
		const classes = await guard(() => api("get_classes"));
		if (!classes) return;
		const name = h("input", { type: "text", maxlength: 80, placeholder: "New class name, for example Room 4" });
		const list = classes.length
			? classes.map((c) => h("button", { class: "btn", onclick: () => { close(); viewClass(c.name); } }, h("span", {}, c.class_name, h("small", {}, `Code ${c.join_code} · ${c.members} ${c.members === 1 ? "reader" : "readers"} · ${c.books.length} assigned`))))
			: h("p", { class: "meta" }, "No classes yet. Make one, then give its code to families.");
		const close = modal("My classes", h("div", {}, h("div", { class: "modes" }, list),
			h("label", { class: "field", style: "margin-top:18px" }, h("span", {}, "Make a class"), name)), (c) => [
			h("button", { class: "btn", onclick: c }, "Close"),
			h("button", { class: "btn primary", onclick: () => guard(async () => {
				const made = await api("save_class", { class_name: name.value }, true);
				c();
				viewClass(made.name);
			}) }, "Create"),
		]);
	}

	async function viewClass(className) {
		const report = await guard(() => api("class_report", { name: className }));
		if (!report) return;
		const titles = {};
		S.boot.books.forEach((b) => (titles[b.name] = b.title));
		const rows = report.readers.map((r) => h("tr", {},
			h("td", {}, (r.avatar || "🦊") + " ", h("b", {}, r.reader_name)),
			h("td", {}, r.books_read),
			h("td", {}, `${r.minutes_week} min`, h("div", { class: "meta" }, `${r.sessions_week} ${r.sessions_week === 1 ? "session" : "sessions"}`)),
			h("td", {}, r.words_helped_week),
			h("td", {}, r.last_read || "–", r.latest_wpm ? h("div", { class: "meta" }, `${r.latest_wpm} words/min`) : null),
			h("td", {}, report.books.length ? `${r.assigned_done.length} of ${report.books.length}` : "–")));
		const boxes = S.boot.books.filter((b) => b.status === "Ready").map((b) =>
			h("label", { class: "field check" }, h("input", { type: "checkbox", checked: report.books.includes(b.name), "data-book": b.name }), h("span", {}, b.title)));
		const body = h("div", {},
			h("div", { class: "joincode" }, h("span", {}, "Class code"), h("b", {}, report.join_code), h("small", {}, "Families type this code into a reader's Settings to join.")),
			h("h3", {}, "Readers"),
			rows.length
				? h("table", { class: "progress" }, h("thead", {}, h("tr", {}, ["Reader", "Books read", "This week", "Words helped", "Last read", "Assigned done"].map((t) => h("th", {}, t)))), h("tbody", {}, rows))
				: h("p", { class: "meta" }, "No readers have joined yet."),
			h("h3", {}, "Assigned books"),
			boxes.length ? boxes : h("p", { class: "meta" }, "There are no books in the library yet."));
		modal(report.class_name, body, (close) => [
			h("button", { class: "btn danger small", onclick: () => window.confirm(`Delete the class "${report.class_name}"? Readers keep their own progress.`) && guard(async () => { await api("delete_class", { name: report.name }, true); close(); viewClasses(); }) }, "Delete class"),
			h("button", { class: "btn", onclick: () => { close(); viewClasses(); } }, "Back"),
			h("button", { class: "btn primary", onclick: () => guard(async () => {
				const books = boxes.map((label) => label.querySelector("input")).filter((box) => box.checked).map((box) => box.dataset.book);
				await api("set_class_books", { name: report.name, books: JSON.stringify(books) }, true);
				close();
				toast("Assigned books saved.");
			}) }, "Save books"),
		], true);
	}

	// ------------------------------------------------------------------ questions about the story

	/** Take the questions straight from the book's menu, without reading first. */
	async function beginQuiz() {
		const session = await guard(() => api("start_session", { reader: S.reader.name, book: S.book.name, mode: "Questions" }, true));
		viewQuiz(session && session.name, true);
	}

	/** The whole story as plain paragraphs, one for each page, for reading silently. */
	function passage() {
		const pages = [];
		S.book.lines.forEach((line) => {
			const last = pages[pages.length - 1];
			if (last && last.page === line.page) last.text += " " + line.text;
			else pages.push({ page: line.page, text: line.text });
		});
		return h("div", { class: "text passage" }, pages.map((pg) => h("p", {}, pg.text)));
	}

	/** Practice test: read the story silently, then answer the questions for a score. */
	async function beginPractice() {
		const session = await guard(() => api("start_session", { reader: S.reader.name, book: S.book.name, mode: "Practice Test" }, true));
		leaveRun();
		const began = performance.now();
		const words = S.book.lines.reduce((n, line) => n + line.text.split(/\s+/).filter(Boolean).length, 0);
		const timer = h("span", { class: "meta", "aria-hidden": "true" }, "⏱ 0:00");
		const tick = setInterval(() => {
			if (!timer.isConnected) return clearInterval(tick);
			timer.textContent = "⏱ " + clock((performance.now() - began) / 1000);
		}, 1000);
		show(
			h("div", { class: "bar" }, h("button", { class: "btn icon-btn", "aria-label": "Back to the library", onclick: () => guard(viewLibrary) }, "✕"),
				h("h1", {}, "Practice test"), timer),
			h("div", { class: "page" }, h("div", { class: "panel practice" },
				h("p", { class: "meta lead" }, "Read this quietly to yourself. Take your time. When you have finished, answer the questions."),
				h("h2", {}, S.book.title),
				passage(),
				h("div", { class: "controls" }, h("span", { class: "spacer" }),
					h("button", { class: "btn primary big", onclick: () => {
						clearInterval(tick);
						viewQuiz(session && session.name, true, { seconds: (performance.now() - began) / 1000, words });
					} }, "I've finished reading ➜"))))
		);
	}

	function viewQuiz(session, standalone, test) {
		leaveRun();
		const began = performance.now();
		const questions = S.book.questions.slice(0, test ? 12 : 6);
		const picked = [];
		let at = 0;
		let right = 0;
		const stage = h("div", { class: "result quiz" });
		const meter = h("i");
		show(
			h("div", { class: "bar" }, h("button", { class: "btn icon-btn", "aria-label": "Back to the library", onclick: () => guard(viewLibrary) }, "✕"),
				h("h1", {}, test ? "Practice test" : "Questions about the story"), h("div", { class: "meter" }, meter)),
			h("div", { class: "page" }, stage)
		);
		const done = () => {
			hush();
			meter.style.width = "100%";
			// Clicking straight through is not reading: only count a speed a child could really read at.
			if (test && !(test.seconds > 0 && (test.words / test.seconds) * 60 <= 500)) test.words = 0;
			if (session) {
				api("save_quiz", { session, correct: right, total: questions.length }, true)
					// Taken on its own, the quiz is a session of its own: finish it so it shows in Progress.
					.then(() => standalone && api("finish_session", { session, data: JSON.stringify({ reader_seconds: test ? test.seconds : (performance.now() - began) / 1000, narrator_seconds: 0, words_total: test ? test.words : 0, helped_words: [] }) }, true))
					.catch(() => {});
			}
			if (right === questions.length) cheer("🎉");
			if (test) {
				const wpm = test.seconds > 0 ? Math.round((test.words / test.seconds) * 60) : 0;
				stage.replaceChildren(
					h("div", { class: "hero" }, h("div", { class: "stars" }, right === questions.length ? "📝⭐" : "📝"),
						h("h2", {}, `Your score: ${right} out of ${questions.length}`),
						h("p", {}, wpm ? `You read ${test.words} words in ${clock(test.seconds)} (about ${wpm} words a minute).` : `Reading time: ${clock(test.seconds)}.`)),
					h("div", { class: "review" }, questions.map((q, i) => {
						const ok = picked[i] === q.answer;
						return h("div", { class: "review-row " + (ok ? "ok" : "miss") },
							h("b", {}, `${ok ? "✓" : "✗"} ${i + 1}. ${q.question}`),
							h("div", {}, "Your answer: ", q.options[picked[i]]),
							!ok && h("div", { class: "fix" }, "Right answer: ", q.options[q.answer]));
					})),
					h("div", { class: "options modes" },
						h("button", { class: "btn primary", onclick: () => guard(beginPractice) }, "📝 Try the practice test again"),
						h("button", { class: "btn", onclick: () => guard(viewLibrary) }, "📚 Back to the library")));
				return;
			}
			stage.replaceChildren(
				h("div", { class: "hero" }, h("div", { class: "stars" }, right === questions.length ? "🤔⭐" : "🤔"),
					h("h2", {}, `You got ${right} of ${questions.length} right!`),
					h("p", {}, right === questions.length ? "You understood the whole story." : "Reading the story again will help with the ones you missed.")),
				practiceOptions(false));
		};
		const ask = () => {
			if (at >= questions.length) return done();
			const q = questions[at];
			meter.style.width = Math.round((at / questions.length) * 100) + "%";
			const read = () => { hush(); speak(`${q.question} ... ${q.options.join(". ... ")}.`); };
			const next = h("button", { class: "btn primary big", hidden: true, onclick: () => {
				if (test && picked[at] === q.answer) right++;
				hush();
				at++;
				ask();
			} }, at + 1 === questions.length ? "Finish ➜" : "Next ➜");
			const options = q.options.map((option, i) => h("button", { class: "btn big option", onclick: () => {
				if (test) {
					// A test: the answer can be changed until Next is pressed, and marks come at the end.
					picked[at] = i;
					options.forEach((btn, j) => btn.classList.toggle("chosen", j === i));
					next.hidden = false;
					return;
				}
				if (!next.hidden) return;
				hush();
				const ok = i === q.answer;
				if (ok) { right++; cheer("⭐"); }
				options.forEach((btn, j) => { btn.disabled = true; btn.classList.add(j === q.answer ? "right" : j === i ? "wrong" : "other"); });
				next.hidden = false;
			} }, option));
			stage.replaceChildren(
				h("p", { class: "meta" }, `Question ${at + 1} of ${questions.length}`),
				h("h2", { class: "question" }, q.question),
				h("div", { class: "options modes" }, options),
				h("div", { class: "controls", style: "justify-content:center;border:0" }, h("button", { class: "btn", onclick: read }, "🔊 Read it to me"),
					test && h("button", { class: "btn", onclick: () => modal(S.book.title, passage(), (close) => [h("button", { class: "btn primary", onclick: close }, "Back to the question")], true) }, "📖 Look at the story again"),
					next));
			if (!test) read();
		};
		ask();
	}

	function viewProgress() {
		const stats = readerStats();
		const tile = (value, label) => h("div", { class: "tile" }, h("b", {}, value), h("span", {}, label));
		const reads = stats.reads.filter((p) => p.reader_wpm > 0).slice(0, 20).reverse();
		const rows = S.progress.slice(0, 15).map((p) => h("tr", {},
			h("td", {}, String(p.completed_on || "").slice(0, 10)),
			h("td", {}, h("b", {}, p.book_title), h("br"), MODE_LABEL[p.mode] || p.mode, p.quiz_total ? h("div", { class: "meta" }, `Questions: ${p.quiz_correct} of ${p.quiz_total} right`) : null),
			h("td", {}, p.reader_seconds ? clock(p.reader_seconds) : "–", p.reader_wpm ? h("div", { class: "meta" }, `${Math.round(p.reader_wpm)} words/min`) : null),
			h("td", {}, p.words_helped ? `${p.words_helped}: ${p.helped_words}` : "none")));
		const body = h("div", {},
			h("div", { class: "tiles" }, tile(stats.books, stats.books === 1 ? "book read" : "books read"), tile(stats.minutes, stats.minutes === 1 ? "minute reading" : "minutes reading"), tile(stats.streak, stats.streak === 1 ? "day in a row" : "days in a row"), tile(stats.mastered, stats.mastered === 1 ? "word mastered" : "words mastered")),
			reads.length > 1 && h("div", { class: "charts" },
				h("div", {}, h("h3", {}, "Words a minute"), chart(reads.map((p) => p.reader_wpm), "line", "#17807a")),
				h("div", {}, h("h3", {}, "Words needing help"), chart(reads.map((p) => p.words_helped || 0), "bar", "#e9624a"))),
			h("h3", {}, "Badges"),
			h("div", { class: "badges" }, stats.badges.map((b) => h("div", { class: "badge" + (b.earned ? " earned" : ""), title: b.earned ? "Earned" : "Not yet" }, h("span", {}, b.icon), b.title))),
			h("h3", {}, "Recent reading"),
			rows.length
				? h("table", { class: "progress" }, h("thead", {}, h("tr", {}, ["Date", "Book", "Time", "Words helped"].map((t) => h("th", {}, t)))), h("tbody", {}, rows))
				: h("p", { class: "meta" }, "Nothing yet. Finished books will show up here."));
		modal(`${S.reader.reader_name}'s reading`, body, (close) => [h("button", { class: "btn primary", onclick: close }, "Close")], true);
	}

	async function openBook(summary) {
		await guard(async () => {
			const book = await api("get_book", { name: summary.name });
			if (!book.lines.length) return toast("This book has no text to read yet.");
			S.book = book;
			let resume = await api("get_resume", { reader: S.reader.name, book: book.name }).catch(() => null);
			if (resume && !(resume.lines_completed > 0 && resume.lines_completed < book.lines.length)) resume = null;
			const pick = (mode, cls, icon, title, sub, from) => h("button", { class: "btn " + cls, onclick: () => { close(); beginRun(mode, from); } }, h("span", { style: "font-size:28px" }, icon), h("span", {}, title, h("small", {}, sub)));
			const close = modal(book.title, h("div", {},
				book.summary && h("p", {}, book.summary),
				h("div", { class: "modes" },
					resume && pick(resume.mode, "sun big", "▶", "Carry on where you stopped", `Page ${book.lines[resume.lines_completed].page} · ${MODE_LABEL[resume.mode]}`, resume),
					pick("Read Together", resume ? "primary" : "primary big", "👂🎤", resume ? "Start again: read together" : "Read together", "Listen to a few lines, then read them back."),
					pick("Re-read", "", "📖", "I'll read it myself", "Read aloud with help when you get stuck."),
					pick("Tricky Words", "", "🧩", "Tricky words", "Practise the long and difficult words."),
					pick("Listen", "", "👂", "Just listen", "Hear the whole story read aloud."),
					(book.questions || []).length > 0 && pick("Questions", "", "❓", "Questions about the story", `${Math.min(book.questions.length, 6)} quick questions to check what you remember.`),
					(book.questions || []).length > 0 && h("button", { class: "btn", onclick: () => { close(); beginPractice(); } }, h("span", { style: "font-size:28px" }, "📝"), h("span", {}, "Practice test", h("small", {}, "Read it quietly to yourself, then answer the questions for a score."))))),
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
			while (extra < 6 && end < lines.length && lines[end].page === page && !SENTENCE_END.test(lines[end - 1].text)) { end++; extra++; }
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

	/** Every sentence the narrator would read in this book, as spoken. Used to record the narrator's voice. */
	function bookSentences(lines) {
		const pages = {};
		lines.forEach((line) => (pages[line.page] = pages[line.page] || []).push(line));
		const out = [];
		Object.keys(pages).forEach((page) => {
			const chunk = makeChunk(pages[page], Number(page));
			let text = "";
			chunk.tokens.forEach((t, idx) => {
				const piece = spokenForm(t);
				if (piece) text += piece + " ";
				if (SENTENCE_END.test(t.text) || idx === chunk.tokens.length - 1) {
					if (text.trim()) out.push(text.trim());
					text = "";
				}
			});
		});
		return out;
	}

	function clearRecordings() {
		(S.recordings || []).forEach((r) => URL.revokeObjectURL(r.url));
		S.recordings = [];
	}

	function startRecording(run, chunk) {
		if (!run.stream || !window.MediaRecorder) return;
		try {
			const recorder = new MediaRecorder(run.stream);
			const parts = [];
			const label = `Page ${chunk.page}, turn ${run.index + 1}`;
			recorder.ondataavailable = (e) => e.data && e.data.size && parts.push(e.data);
			recorder.onstop = () => { if (parts.length) S.recordings.push({ label, url: URL.createObjectURL(new Blob(parts, { type: recorder.mimeType })) }); };
			recorder.start();
			run.recorder = recorder;
		} catch (e) { run.recorder = null; }
	}

	function stopRecording(run) {
		if (run.recorder && run.recorder.state !== "inactive") run.recorder.stop();
		run.recorder = null;
	}

	function leaveRun() {
		if (S.run) {
			stopRecording(S.run);
			if (S.run.stream) S.run.stream.getTracks().forEach((track) => track.stop());
		}
		document.body.classList.remove("in-session");
		if (S.run) {
			S.run.dead = true;
			if (S.run.listener) S.run.listener.stop();
			clearInterval(S.run.ticker);
			S.run = null;
		}
		hush();
	}

	async function beginRun(mode, resume) {
		leaveRun();
		beep(660, 60); // unlock audio inside the tap that started the run
		if (mode === "Tricky Words") return beginTricky();
		if (mode === "Questions") return beginQuiz();
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
		let startAt = 0;
		if (resume) {
			let lines = 0;
			while (startAt < run.chunks.length && lines + run.chunks[startAt].lines.length <= resume.lines_completed) lines += run.chunks[startAt++].lines.length;
			if (startAt >= run.chunks.length) startAt = 0;
			else {
				run.session = resume.session;
				run.readerMs = (resume.reader_seconds || 0) * 1000;
				run.helped = (resume.helped_words || []).slice();
				if (mode !== "Re-read") {
					run.narratorSec = resume.narrator_seconds || 0;
					run.narratedWords = run.chunks.slice(0, startAt).reduce((n, c) => n + c.words, 0);
				}
			}
		}
		clearRecordings();
		renderReadView(run);
		try {
			if (pref("record_reading") && mode !== "Listen" && navigator.mediaDevices && window.MediaRecorder) {
				try { run.stream = await navigator.mediaDevices.getUserMedia({ audio: true }); } catch (e) { run.stream = null; }
				if (run.dead) { if (run.stream) run.stream.getTracks().forEach((track) => track.stop()); return; }
			}
			if (S.boot.narration_enabled && mode !== "Re-read") {
				run.narration = await api("get_narration", { book: S.book.name, country: pref("voice_country"), gender: pref("voice_gender") }).catch(() => null);
			}
			if (!run.session) run.session = (await api("start_session", { reader: S.reader.name, book: S.book.name, mode }, true)).name;
			try { S.pdf = S.book.pdf ? await openPdf(S.book.pdf) : null; } catch (e) { S.pdf = null; }
			for (run.index = startAt; run.index < run.chunks.length && !run.dead; run.index++) {
				await playChunk(run, run.chunks[run.index]);
				if (!run.dead) saveProgress(run);
			}
			if (!run.dead) await finishRun(run);
		} catch (e) {
			if (!run.dead) { console.error(e); toast(e.message || String(e), 6000); }
		}
	}

	/** Remember how far this book has got, so it can be carried on another day. */
	function saveProgress(run, leaving) {
		if (run.mode === "Listen" || !run.session || (!leaving && run.index + 1 >= run.chunks.length)) return;
		// When leaving part-way through a turn, only the turns already finished count as read.
		const lines = run.chunks.slice(0, leaving ? run.index : run.index + 1).reduce((n, c) => n + c.lines.length, 0);
		if (leaving && !lines) return;
		api("save_progress", { session: run.session, data: JSON.stringify({ lines_completed: lines, reader_seconds: run.readerMs / 1000, narrator_seconds: run.narratorSec, helped_words: run.helped }) }, true).catch(() => {});
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
		ui.hint = h("div", { class: "hint", hidden: true, "aria-live": "polite" });
		ui.pause = h("button", { class: "btn", onclick: () => togglePause(run) }, "⏸ Pause");
		ui.again = h("button", { class: "btn", onclick: () => run.replay && run.replay() }, "🔁 Again");
		ui.help = h("button", { class: "btn sun", onclick: () => run.helpNow && run.helpNow() }, "💡 Help me");
		ui.done = h("button", { class: "btn primary", onclick: () => run.endTurn && run.endTurn() }, "✓ I've read it");
		ui.mic = h("button", { class: "btn small", onclick: () => toggleMic(run) });
		show(
			h("div", { class: "bar" },
				h("button", { class: "btn icon-btn", title: "Back to the library", "aria-label": "Back to the library", onclick: () => { if (window.confirm("Stop reading and go back to the library? You can carry on later.")) { saveProgress(run, true); guard(viewLibrary); } } }, "✕"),
				h("h1", {}, S.book.title),
				h("div", { class: "meter", title: "How far through the book" }, ui.meter),
				ui.pageLabel,
				ui.clock),
			h("div", { class: "read" }, ui.sheet,
				h("div", { class: "panel" }, ui.phase, ui.hint, ui.text,
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
			// A book made from text or an EPUB has no page image: show its lines instead.
			const inChunk = new Set(chunk.lines);
			const rows = S.book.lines.filter((line) => line.page === chunk.page).map((line) => {
				const el = h("div", { class: "tline" + (inChunk.has(line) ? " hl-line" : "") }, line.text);
				line.hl = inChunk.has(line) ? el : null;
				return el;
			});
			ui.pagewrap.style.width = "";
			ui.pagewrap.replaceChildren(h("div", { class: "textpage" }, rows));
			const first = chunk.lines.find((line) => line.hl);
			if (first) ui.sheet.scrollTo({ top: Math.max(0, first.hl.offsetTop - 40), behavior: "smooth" });
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
			const voiceOpts = {
				onstart: () => { for (let i = a; i < b; i++) chunk.tokens[i].el.classList.add("speaking"); markLine(chunk, chunk.tokens[a].line); },
				onword: light,
			};
			// Use the recorded narrator when this sentence has a clip; otherwise the device's own voice.
			const clip = run.narration && run.narration.clips && run.narration.clips[textKey(text)];
			let seconds = clip ? await playClip(clip, voiceOpts, text.length) : null;
			if (seconds === null && !(run.dead || run.paused || replay)) seconds = await speak(text, voiceOpts);
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
		run.ui.hint.hidden = true;
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
				stopRecording(run);
				if (run.listener) run.listener.stop();
				if (!run.paused) run.readerMs += performance.now() - turn.started;
				chunk.tokens.forEach((t) => { t.el.classList.remove("cur"); t.el.classList.add("done"); });
				markLine(chunk, -1);
				run.turn = run.helpNow = run.endTurn = null;
				resolve();
			};
			run.endTurn = turn.finish;
			startRecording(run, chunk);
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
		const word = token.text.replace(/^[^A-Za-z0-9]+|[^A-Za-z0-9]+$/g, "");
		const pieces = pref("syllable_hint") ? syllables(word) : [];
		const hintFirst = pieces.length > 1;
		token.helps++;
		if (hintFirst && token.helps === 1) {
			// First nudge: show the word in syllables and give the reader another go.
			run.ui.hint.replaceChildren(h("span", {}, "Try it in pieces:"), h("b", {}, pieces.join(" · ")));
			run.ui.hint.hidden = false;
			markToken(chunk, tokIdx, "cur"); // keep the word in view now that the hint takes some room
			turn.lastMove = performance.now();
			return;
		}
		turn.busy = true;
		if (run.listener) run.listener.stop(); // don't let the microphone hear the narrator
		token.el.classList.add("helped");
		if (!run.helped.some((w) => w.toLowerCase() === word.toLowerCase())) run.helped.push(word);
		hush();
		await speak(word, { rate: Math.max(0.6, pref("speech_rate") - 0.15) });
		if (run.dead || turn.over) return;
		turn.busy = false;
		const current = chunk.expected[turn.pointer].tok;
		if (tokIdx === current && token.helps >= (hintFirst ? 3 : 2)) {
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
		const before = new Set(readerStats().badges.filter((b) => b.earned).map((b) => b.id));
		updateReader(result.reader);
		viewResults(run, result, before);
	}

	function practiceOptions(primary) {
		const opt = (mode, icon, title, sub, cls) => h("button", { class: "btn " + (cls || ""), onclick: () => beginRun(mode) }, h("span", { style: "font-size:28px" }, icon), h("span", {}, title, h("small", {}, sub)));
		return h("div", { class: "options modes" },
			opt("Re-read", "📖", "Read it again", "Read the story out loud once more.", primary ? "primary big" : ""),
			opt("Tricky Words", "🧩", "Practise the tricky words", "Hear and say the long and difficult words.", primary ? "sun" : ""),
			opt("Listen", "👂", "Listen to the whole story", "Sit back and hear it read aloud.", ""),
			h("button", { class: "btn", onclick: () => guard(viewLibrary) }, "📚 Back to the library"));
	}

	function viewResults(run, r, badgesBefore) {
		leaveRun();
		const share = r.words_total ? r.words_helped / r.words_total : 0;
		const stars = run.mode === "Listen" ? 0 : share <= 0.02 ? 3 : share <= 0.08 ? 2 : 1;
		const feedback = h("div", { class: "feedback" }, "…");
		const newBadges = h("div", { class: "badges new", hidden: true });
		const canQuiz = (S.book.questions || []).length > 0;
		const recordings = (S.recordings || []).length
			? h("div", { class: "recordings" }, h("h3", {}, "🎧 Hear yourself read"), S.recordings.map((r) => h("div", { class: "recording" }, h("span", {}, r.label), h("audio", { controls: true, src: r.url, preload: "metadata" }))))
			: null;
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
				newBadges,
				canQuiz && h("div", { class: "options modes" }, h("button", { class: "btn sun big", onclick: () => viewQuiz(r.name) }, h("span", { style: "font-size:28px" }, "❓"), h("span", {}, "Answer questions about the story", h("small", {}, `${Math.min(S.book.questions.length, 6)} quick questions`)))),
				recordings,
				feedback,
				r.suggest_practice && h("h3", {}, "What would you like to do next?"),
				practiceOptions(r.suggest_practice)))
		);
		api("session_feedback", { session: r.name }, true)
			.then((f) => (feedback.textContent = f.feedback))
			.catch(() => feedback.remove());
		if (badgesBefore) {
			api("get_progress", { reader: S.reader.name }).then((progress) => {
				S.progress = progress;
				const earned = readerStats().badges.filter((b) => b.earned && !badgesBefore.has(b.id));
				if (!earned.length) return;
				newBadges.replaceChildren(h("h3", {}, earned.length === 1 ? "New badge!" : "New badges!"), ...earned.map((b) => h("div", { class: "badge earned" }, h("span", {}, b.icon), b.title)));
				newBadges.hidden = false;
				cheer("🏅");
			}).catch(() => {});
		}
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
				if (said) { cheer("⭐"); setTimeout(() => resolve(true), 800); } else resolve(false);
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
					!SR && h("button", { class: "btn big", onclick: () => done(true) }, "✓ I said it"),
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
	window.ESReading = { tokenize, advance, similar, buildChunks, extractPdf, syllables, textKey, bookSentences }; // exposed for testing
	start().catch((e) => {
		console.error(e);
		show(h("div", { class: "page" }, h("div", { class: "hero" }, h("h2", {}, "ES Reading couldn't start"), h("p", {}, e.message || String(e)))));
	});
})();

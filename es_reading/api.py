"""Whitelisted API behind the /reading page.

Families are ordinary signed-in users with no special role. Every method checks that the reader or
session being touched belongs to the signed-in account, so documents are read and written with
ignore_permissions after that check. Books are managed by System Managers and Reading Librarians.
"""

import base64
import json
import re

import frappe
from frappe import _
from frappe.utils import cint, flt, now_datetime

from es_reading import claude
from es_reading.es_reading.doctype.reading_book.reading_book import skipped_pages
from es_reading.install import DEFAULTS

LIBRARIAN_ROLES = {"System Manager", "Reading Librarian"}
MODES = ("Read Together", "Re-read", "Tricky Words", "Listen")
COUNTRIES = (
	"Australia",
	"United Kingdom",
	"United States",
	"New Zealand",
	"Ireland",
	"Canada",
	"South Africa",
	"India",
)
READER_FIELDS = (
	"reader_name",
	"avatar",
	"voice_country",
	"voice_gender",
	"voice_name",
	"speech_rate",
	"lines_per_turn",
	"silence_seconds",
	"gap_percent",
	"reading_age",
	"syllable_hint",
	"display_prefs",
)
DISPLAY_OPTIONS = {
	"font": ("default", "lexend"),
	"size": ("normal", "large", "xlarge"),
	"spacing": ("normal", "wide"),
	"background": ("cream", "white", "blue", "yellow", "dark"),
}
RESUMABLE_MODES = ("Read Together", "Re-read")
MASTERED_AFTER = 3
SKIP_PATTERNS = (
	re.compile(r"^\W*(page\s*)?\d+(\s*(of|/)\s*\d+)?\W*$", re.I),  # page numbers
	re.compile(r"_{3,}"),  # blanks to fill in
)


# --------------------------------------------------------------------------- helpers


def _require_login():
	if frappe.session.user == "Guest":
		frappe.throw(_("Please sign in to use ES Reading."), frappe.AuthenticationError)


def _guests_allowed():
	return bool(cint(frappe.db.get_single_value("ES Reading Settings", "allow_guests")))


def _require_access():
	"""Reading books is open to signed-in users, and to guests when the setting allows it."""
	if frappe.session.user == "Guest" and not _guests_allowed():
		frappe.throw(_("Please sign in to use ES Reading."), frappe.AuthenticationError)


def _is_librarian():
	return bool(LIBRARIAN_ROLES & set(frappe.get_roles()))


def _require_librarian():
	_require_login()
	if not _is_librarian():
		frappe.throw(_("Only a librarian can manage books."), frappe.PermissionError)


def _defaults():
	settings = frappe.get_single("ES Reading Settings")
	out = {}
	for key in ("lines_per_turn", "silence_seconds", "gap_percent", "tricky_word_length", "max_readers", "max_pdf_mb"):
		out[key] = cint(settings.get(key)) or DEFAULTS[key]
	out["speech_rate"] = flt(settings.speech_rate) or DEFAULTS["speech_rate"]
	out["voice_country"] = settings.voice_country or DEFAULTS["voice_country"]
	out["voice_gender"] = settings.voice_gender or DEFAULTS["voice_gender"]
	return out


def _own_reader(name):
	_require_login()
	doc = frappe.get_doc("Reader Profile", name)
	if doc.family_user != frappe.session.user:
		frappe.throw(_("That reader belongs to another family."), frappe.PermissionError)
	return doc


def _own_session(name):
	_require_login()
	doc = frappe.get_doc("Reading Session", name)
	if doc.family_user != frappe.session.user:
		frappe.throw(_("That session belongs to another family."), frappe.PermissionError)
	return doc


def _reader_dict(doc):
	out = {"name": doc.name}
	for key in READER_FIELDS:
		out[key] = doc.get(key)
	out["word_bank"] = _word_bank(doc)
	return out


def _word_bank(doc):
	"""{normalised word: {"w": as written, "h": times helped, "r": right in a row, "last": date}}"""
	try:
		bank = json.loads(doc.word_bank or "{}")
		return bank if isinstance(bank, dict) else {}
	except ValueError:
		return {}


def _word_key(word):
	return re.sub(r"[^a-z0-9]+", "", str(word).lower().replace("’", "").replace("'", ""))


def _store_word_bank(doc, bank):
	if len(bank) > 400:  # keep the most recent words
		keep = sorted(bank.items(), key=lambda kv: kv[1].get("last") or "", reverse=True)[:400]
		bank = dict(keep)
	doc.db_set("word_bank", json.dumps(bank, separators=(",", ":")), update_modified=False)


def _readers():
	names = frappe.get_all(
		"Reader Profile", filters={"family_user": frappe.session.user}, order_by="creation asc", pluck="name"
	)
	return [_reader_dict(frappe.get_doc("Reader Profile", name)) for name in names]


def _books():
	filters = {} if _is_librarian() else {"status": "Ready", "published": 1}
	return frappe.get_all(
		"Reading Book",
		filters=filters,
		fields=[
			"name",
			"title",
			"cover_image",
			"custom_cover",
			"status",
			"published",
			"reading_level",
			"shelf",
			"skip_pages",
			"summary",
			"page_count",
			"word_count",
			"pdf",
			"note",
		],
		order_by="title asc",
	)


def _clamp(value, low, high, default=None):
	if value in (None, ""):
		return default
	return max(low, min(high, value))


# --------------------------------------------------------------------------- bootstrap


@frappe.whitelist(allow_guest=True)
def get_bootstrap():
	_require_access()
	guest = frappe.session.user == "Guest"
	return {
		"user": "" if guest else frappe.utils.get_fullname(frappe.session.user),
		# A guest has no account: the page keeps their readers and progress in the browser.
		"guest": guest,
		"is_librarian": False if guest else _is_librarian(),
		"ai_enabled": False if guest else claude.is_configured(),
		"defaults": _defaults(),
		"countries": COUNTRIES,
		"readers": [] if guest else _readers(),
		"books": _books(),
	}


@frappe.whitelist(allow_guest=True)
def get_books():
	_require_access()
	return _books()


# --------------------------------------------------------------------------- readers


@frappe.whitelist(methods=["POST"])
def save_reader(data):
	_require_login()
	data = frappe.parse_json(data)
	if data.get("name"):
		doc = _own_reader(data["name"])
	else:
		limit = _defaults()["max_readers"]
		if frappe.db.count("Reader Profile", {"family_user": frappe.session.user}) >= limit:
			frappe.throw(_("You can have up to {0} readers.").format(limit))
		doc = frappe.new_doc("Reader Profile")
		doc.family_user = frappe.session.user

	if "reader_name" in data:
		doc.reader_name = frappe.utils.strip_html(str(data["reader_name"] or "")).strip()[:40]
	if not doc.reader_name:
		frappe.throw(_("Please give the reader a name."))
	if "avatar" in data:
		doc.avatar = str(data["avatar"] or "")[:8]
	if "voice_country" in data:
		doc.voice_country = data["voice_country"] if data["voice_country"] in COUNTRIES else ""
	if "voice_gender" in data:
		doc.voice_gender = data["voice_gender"] if data["voice_gender"] in ("Female", "Male") else ""
	if "voice_name" in data:
		doc.voice_name = str(data["voice_name"] or "")[:140]
	if "speech_rate" in data:
		doc.speech_rate = _clamp(flt(data["speech_rate"]), 0.5, 1.5, 0)
	if "lines_per_turn" in data:
		doc.lines_per_turn = _clamp(cint(data["lines_per_turn"]), 1, 40, 0)
	if "silence_seconds" in data:
		doc.silence_seconds = _clamp(cint(data["silence_seconds"]), 2, 20, 0)
	if "gap_percent" in data:
		doc.gap_percent = _clamp(cint(data["gap_percent"]), 5, 300, 0)
	if "reading_age" in data:
		doc.reading_age = _clamp(cint(data["reading_age"]), 4, 18, 0) if cint(data["reading_age"]) else 0
	if "syllable_hint" in data:
		doc.syllable_hint = 1 if cint(data["syllable_hint"]) else 0
	elif doc.is_new():
		doc.syllable_hint = 1
	if "display_prefs" in data:
		chosen = data["display_prefs"]
		if isinstance(chosen, str):
			try:
				chosen = json.loads(chosen or "{}")
			except ValueError:
				chosen = {}
		chosen = chosen if isinstance(chosen, dict) else {}
		doc.display_prefs = json.dumps({k: chosen[k] for k, allowed in DISPLAY_OPTIONS.items() if chosen.get(k) in allowed})
	doc.save(ignore_permissions=True)
	return _reader_dict(doc)


@frappe.whitelist(methods=["POST"])
def delete_reader(name):
	"""Remove a reader and all of their reading history."""
	doc = _own_reader(name)
	frappe.db.delete("Reading Session", {"reader": doc.name})
	frappe.delete_doc("Reader Profile", doc.name, ignore_permissions=True, force=True)
	return {"ok": True}


@frappe.whitelist()
def get_progress(reader):
	doc = _own_reader(reader)
	sessions = frappe.get_all(
		"Reading Session",
		filters={"reader": doc.name, "status": "Completed"},
		fields=[
			"name",
			"book",
			"mode",
			"completed_on",
			"reader_seconds",
			"narrator_seconds",
			"gap_percent",
			"words_total",
			"words_helped",
			"helped_words",
			"reader_wpm",
		],
		order_by="completed_on desc",
		limit=300,
	)
	titles = {}
	for row in sessions:
		if row.book not in titles:
			titles[row.book] = frappe.db.get_value("Reading Book", row.book, "title") or row.book
		row["book_title"] = titles[row.book]
	return sessions


# --------------------------------------------------------------------------- books


@frappe.whitelist(allow_guest=True)
def get_book(name):
	_require_access()
	doc = frappe.get_doc("Reading Book", name)
	if not _is_librarian() and not (doc.status == "Ready" and doc.published):
		frappe.throw(_("That book is not available."), frappe.PermissionError)
	skipped = skipped_pages(doc.skip_pages)
	readable = [line for line in doc.lines if not line.skip and (line.text or "").strip()]
	out = {
		"name": doc.name,
		"title": doc.title,
		"pdf": doc.pdf,
		"status": doc.status,
		"reading_level": doc.reading_level,
		"shelf": doc.shelf,
		"summary": doc.summary,
		"page_count": doc.page_count,
		"lines": [
			{"page": line.page_no or 1, "text": line.text, "x": line.x, "y": line.y, "w": line.w, "h": line.h}
			for line in readable
			if (line.page_no or 1) not in skipped
		],
		"tricky_words": [{"word": w.word, "say": w.say, "meaning": w.meaning} for w in doc.tricky_words],
	}
	if _is_librarian():
		pages = {}
		for line in readable:
			page = pages.setdefault(line.page_no or 1, {"page": line.page_no or 1, "lines": 0, "words": 0, "first": ""})
			page["lines"] += 1
			page["words"] += len(line.text.split())
			page["first"] = page["first"] or line.text.strip()[:70]
		for page in pages.values():
			page["read"] = page["page"] not in skipped
		out["page_info"] = [pages[n] for n in sorted(pages)]
	return out


@frappe.whitelist(methods=["POST"])
def update_book(book, data):
	"""Librarian: change a book's title, shelf, reading level or summary."""
	_require_librarian()
	doc = frappe.get_doc("Reading Book", book)
	data = frappe.parse_json(data) or {}
	clean = lambda value, size: frappe.utils.strip_html(str(value or "")).strip()[:size]  # noqa: E731
	if "title" in data and clean(data["title"], 140):
		doc.title = clean(data["title"], 140)
	if "shelf" in data:
		doc.shelf = clean(data["shelf"], 60)
	if "reading_level" in data:
		doc.reading_level = clean(data["reading_level"], 60)
	if "summary" in data:
		doc.summary = clean(data["summary"], 300)
	doc.flags.cover_from_scan = True
	doc.save(ignore_permissions=True)
	return {"name": doc.name, "title": doc.title, "shelf": doc.shelf, "reading_level": doc.reading_level, "summary": doc.summary}


@frappe.whitelist(methods=["POST"])
def set_book_pages(book, skip_pages):
	"""Librarian: choose which pages are left out of the reading."""
	_require_librarian()
	doc = frappe.get_doc("Reading Book", book)
	pages = frappe.parse_json(skip_pages) or []
	doc.skip_pages = ", ".join(str(cint(n)) for n in pages if cint(n) > 0)
	doc.flags.cover_from_scan = True
	doc.save(ignore_permissions=True)
	if not doc.line_count:
		frappe.throw(_("Leave at least one page to read."))
	return {"name": doc.name, "skip_pages": doc.skip_pages, "lines": doc.line_count, "words": doc.word_count}


@frappe.whitelist(methods=["POST"])
def create_book(title=None):
	"""Upload a PDF (multipart field "file") and create its Reading Book."""
	_require_librarian()
	upload = frappe.request.files.get("file") if frappe.request else None
	if not upload:
		frappe.throw(_("Please choose a PDF file."))
	content = upload.stream.read()
	limit = _defaults()["max_pdf_mb"]
	if len(content) > limit * 1024 * 1024:
		frappe.throw(_("That PDF is larger than {0} MB.").format(limit))
	if not content.lstrip()[:5].startswith(b"%PDF"):
		frappe.throw(_("That file is not a PDF."))

	filename = re.sub(r"[^A-Za-z0-9._ -]", "", upload.filename or "book.pdf").strip() or "book.pdf"
	if not filename.lower().endswith(".pdf"):
		filename += ".pdf"
	title = frappe.utils.strip_html(title or "").strip() or filename[:-4].replace("_", " ")

	book = frappe.get_doc({"doctype": "Reading Book", "title": title[:140], "status": "Uploaded"})
	book.insert(ignore_permissions=True)
	file_doc = frappe.get_doc(
		{
			"doctype": "File",
			"file_name": filename,
			"content": content,
			"is_private": 0,
			"attached_to_doctype": "Reading Book",
			"attached_to_name": book.name,
			"attached_to_field": "pdf",
		}
	)
	file_doc.insert(ignore_permissions=True)
	book.db_set("pdf", file_doc.file_url)
	return {"name": book.name, "title": book.title, "pdf": file_doc.file_url}


COVER_TYPES = {"jpg": "JPEG", "jpeg": "JPEG", "png": "PNG", "webp": "WEBP", "gif": "GIF"}
MAX_COVER_MB = 5


def _attach_cover(doc, filename, content):
	file_doc = frappe.get_doc(
		{
			"doctype": "File",
			"file_name": filename,
			"content": content,
			"is_private": 0,
			"attached_to_doctype": "Reading Book",
			"attached_to_name": doc.name,
			"attached_to_field": "cover_image",
		}
	)
	file_doc.insert(ignore_permissions=True)
	return file_doc.file_url


def _save_page_cover(doc, cover):
	"""Use the picture of page 1 that the browser rendered (a JPEG data URL) as the cover."""
	if not (cover and str(cover).startswith("data:image/jpeg;base64,")):
		return False
	try:
		image = base64.b64decode(str(cover).split(",", 1)[1])
		if len(image) > 600 * 1024:
			return False
		doc.cover_image = _attach_cover(doc, f"{doc.name}-cover.jpg", image)
		doc.flags.cover_from_scan = True
		return True
	except Exception:
		# A cover is a nicety; never fail the book over it.
		frappe.log_error(title="ES Reading: cover image not saved")
		return False


@frappe.whitelist(methods=["POST"])
def set_book_cover(book, page_cover=None):
	"""Give a book its own picture (multipart field "file"), or go back to page 1 (page_cover data URL)."""
	_require_librarian()
	doc = frappe.get_doc("Reading Book", book)
	upload = frappe.request.files.get("file") if frappe.request else None

	if upload:
		content = upload.stream.read()
		if len(content) > MAX_COVER_MB * 1024 * 1024:
			frappe.throw(_("That picture is larger than {0} MB.").format(MAX_COVER_MB))
		ext = (upload.filename or "").rsplit(".", 1)[-1].lower()
		if ext not in COVER_TYPES:
			frappe.throw(_("Please choose a JPG, PNG, WebP or GIF picture."))
		try:
			import io

			from PIL import Image

			with Image.open(io.BytesIO(content)) as image:
				actual = image.format
				image.verify()
		except Exception:
			frappe.throw(_("That file is not a picture this app can use."))
		if actual != COVER_TYPES[ext]:
			frappe.throw(_("That file is not a picture this app can use."))
		doc.cover_image = _attach_cover(doc, f"{doc.name}-picture.{ext}", content)
		doc.flags.cover_from_scan = True  # set the flag ourselves below
		doc.custom_cover = 1
	elif page_cover:
		if not _save_page_cover(doc, page_cover):
			frappe.throw(_("The picture of page 1 could not be saved."))
		doc.custom_cover = 0
	else:
		frappe.throw(_("Please choose a picture."))

	doc.save(ignore_permissions=True)
	return {"name": doc.name, "cover_image": doc.cover_image, "custom_cover": doc.custom_cover}


def _should_skip(text):
	if not re.search(r"[A-Za-z]", text):
		return True
	return any(pattern.search(text) for pattern in SKIP_PATTERNS)


@frappe.whitelist(methods=["POST"])
def save_book_content(book, pages, page_count=0, cover=None):
	"""Store the lines the browser found in the PDF (text and position of each line on its page)."""
	_require_librarian()
	doc = frappe.get_doc("Reading Book", book)
	pages = frappe.parse_json(pages) or []

	doc.set("lines", [])
	for page in pages:
		for line in page.get("lines") or []:
			text = re.sub(r"\s+", " ", str(line.get("text") or "")).strip()
			if not text:
				continue
			doc.append(
				"lines",
				{
					"page_no": cint(page.get("page")) or 1,
					"text": text[:1000],
					"skip": 1 if _should_skip(text) else 0,
					"x": _clamp(flt(line.get("x")), 0, 1, 0),
					"y": _clamp(flt(line.get("y")), 0, 1, 0),
					"w": _clamp(flt(line.get("w")), 0, 1, 0),
					"h": _clamp(flt(line.get("h")), 0, 1, 0),
				},
			)
	doc.page_count = cint(page_count)
	doc.set("tricky_words", [])
	doc.ai_prepared = 0
	doc.note = ""

	if not doc.custom_cover:
		_save_page_cover(doc, cover)

	has_text = any(not line.skip for line in doc.lines)
	ai = claude.is_configured()
	if has_text:
		doc.status = "Ready"
	elif ai:
		doc.status = "Preparing"
		doc.note = "No text layer found. Claude is transcribing the pages."
	else:
		doc.status = "Needs Text"
		doc.note = "No text layer found. Add a Claude API key in ES Reading Settings to transcribe scanned PDFs."
	doc.save(ignore_permissions=True)

	if ai:
		job = "es_reading.claude.prepare_book" if has_text else "es_reading.claude.extract_text"
		frappe.enqueue(job, queue="long", timeout=900, enqueue_after_commit=True, book=doc.name)
	return {"name": doc.name, "status": doc.status, "lines": doc.line_count, "words": doc.word_count, "note": doc.note}


@frappe.whitelist(methods=["POST"])
def set_book_published(book, published):
	_require_librarian()
	frappe.db.set_value("Reading Book", book, "published", 1 if cint(published) else 0)
	return {"ok": True}


@frappe.whitelist(methods=["POST"])
def delete_book(book):
	_require_librarian()
	frappe.db.delete("Reading Session", {"book": book})
	frappe.delete_doc("Reading Book", book, ignore_permissions=True, force=True)
	return {"ok": True}


# --------------------------------------------------------------------------- sessions


@frappe.whitelist(methods=["POST"])
def start_session(reader, book, mode="Read Together"):
	reader_doc = _own_reader(reader)
	if mode not in MODES:
		mode = "Read Together"
	if not frappe.db.exists("Reading Book", book):
		frappe.throw(_("That book is not available."))
	doc = frappe.get_doc(
		{
			"doctype": "Reading Session",
			"reader": reader_doc.name,
			"family_user": frappe.session.user,
			"book": book,
			"mode": mode,
			"status": "In Progress",
			"started_on": now_datetime(),
		}
	)
	doc.insert(ignore_permissions=True)
	return {"name": doc.name}


def _helped_list(words):
	cleaned = [re.sub(r"^[^A-Za-z0-9]+|[^A-Za-z0-9]+$", "", frappe.utils.strip_html(str(w)))[:40] for w in (words or [])]
	return [w for w in cleaned if w][:200]


@frappe.whitelist(methods=["POST"])
def save_progress(session, data):
	"""Remember how far an unfinished book has got, so it can be carried on later."""
	doc = _own_session(session)
	if doc.status != "In Progress":
		return {"ok": False}
	data = frappe.parse_json(data) or {}
	helped = _helped_list(data.get("helped_words"))
	frappe.db.set_value(
		"Reading Session",
		doc.name,
		{
			"lines_completed": _clamp(cint(data.get("lines_completed")), 0, 100000, 0),
			"reader_seconds": _clamp(flt(data.get("reader_seconds")), 0, 6 * 3600, 0),
			"narrator_seconds": _clamp(flt(data.get("narrator_seconds")), 0, 6 * 3600, 0),
			"words_helped": len(helped),
			"helped_words": ", ".join(helped)[:2000],
		},
	)
	return {"ok": True}


@frappe.whitelist()
def get_resume(reader, book):
	"""The reader's most recent unfinished session for this book, if any."""
	reader_doc = _own_reader(reader)
	rows = frappe.get_all(
		"Reading Session",
		filters={
			"reader": reader_doc.name,
			"book": book,
			"status": "In Progress",
			"mode": ("in", RESUMABLE_MODES),
			"lines_completed": (">", 0),
			"started_on": (">", frappe.utils.add_days(now_datetime(), -30)),
		},
		fields=["name", "mode", "lines_completed", "reader_seconds", "narrator_seconds", "helped_words"],
		order_by="modified desc",
		limit=1,
	)
	if not rows:
		return None
	row = rows[0]
	row["session"] = row.pop("name")
	row["helped_words"] = [w for w in (row.get("helped_words") or "").split(", ") if w]
	return row


@frappe.whitelist(methods=["POST"])
def practise_words(reader, results):
	"""Record word-bank practice: a word said correctly three times in a row is mastered."""
	doc = _own_reader(reader)
	bank = _word_bank(doc)
	for item in (frappe.parse_json(results) or [])[:100]:
		key = _word_key(item.get("word"))
		if key in bank:
			bank[key]["r"] = min(cint(bank[key].get("r")) + 1, MASTERED_AFTER) if item.get("right") else 0
			bank[key]["last"] = frappe.utils.today()
	_store_word_bank(doc, bank)
	return _reader_dict(frappe.get_doc("Reader Profile", doc.name))


@frappe.whitelist(methods=["POST"])
def finish_session(session, data):
	"""Record the timings measured in the browser and work out the reading-time gap."""
	doc = _own_session(session)
	data = frappe.parse_json(data) or {}
	reader_doc = frappe.get_doc("Reader Profile", doc.reader)

	doc.reader_seconds = _clamp(flt(data.get("reader_seconds")), 0, 6 * 3600, 0)
	doc.narrator_seconds = _clamp(flt(data.get("narrator_seconds")), 0, 6 * 3600, 0)
	doc.words_total = _clamp(cint(data.get("words_total")), 0, 200000, 0)
	doc.listening_used = 1 if cint(data.get("listening_used")) else 0
	helped = _helped_list(data.get("helped_words"))
	doc.words_helped = len(helped)
	doc.helped_words = ", ".join(helped)[:2000]

	doc.gap_percent = 0
	doc.reader_wpm = doc.narrator_wpm = 0
	if doc.reader_seconds and doc.narrator_seconds:
		doc.gap_percent = (doc.reader_seconds - doc.narrator_seconds) / doc.narrator_seconds * 100
	if doc.words_total and doc.reader_seconds:
		doc.reader_wpm = doc.words_total / doc.reader_seconds * 60
	if doc.words_total and doc.narrator_seconds:
		doc.narrator_wpm = doc.words_total / doc.narrator_seconds * 60
	doc.status = "Completed"
	doc.completed_on = now_datetime()
	doc.save(ignore_permissions=True)

	if helped:
		bank = _word_bank(reader_doc)
		for word in helped:
			key = _word_key(word)
			if not key:
				continue
			entry = bank.setdefault(key, {"w": word.lower(), "h": 0, "r": 0})
			entry["h"] = cint(entry.get("h")) + 1
			entry["r"] = 0  # needing help again puts a mastered word back into practice
			entry["last"] = frappe.utils.today()
		_store_word_bank(reader_doc, bank)

	threshold = cint(reader_doc.gap_percent) or _defaults()["gap_percent"]
	return {
		"name": doc.name,
		"reader_seconds": doc.reader_seconds,
		"narrator_seconds": doc.narrator_seconds,
		"gap_percent": round(doc.gap_percent, 1),
		"threshold": threshold,
		"suggest_practice": bool(doc.reader_seconds and doc.narrator_seconds and doc.gap_percent > threshold),
		"words_total": doc.words_total,
		"words_helped": doc.words_helped,
		"reader_wpm": round(doc.reader_wpm),
		"narrator_wpm": round(doc.narrator_wpm),
		"reader": _reader_dict(frappe.get_doc("Reader Profile", reader_doc.name)),
	}


@frappe.whitelist(methods=["POST"])
def session_feedback(session):
	"""Encouragement for the child plus a tip for the grown-up. Written once per session."""
	doc = _own_session(session)
	if doc.status != "Completed":
		frappe.throw(_("That session is not finished yet."))
	if not doc.feedback:
		doc.db_set("feedback", claude.session_feedback(doc))
	return {"feedback": doc.feedback}

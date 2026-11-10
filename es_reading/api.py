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
)
SKIP_PATTERNS = (
	re.compile(r"^\W*(page\s*)?\d+(\s*(of|/)\s*\d+)?\W*$", re.I),  # page numbers
	re.compile(r"_{3,}"),  # blanks to fill in
)


# --------------------------------------------------------------------------- helpers


def _require_login():
	if frappe.session.user == "Guest":
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
	return out


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
			"status",
			"published",
			"reading_level",
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


@frappe.whitelist()
def get_bootstrap():
	_require_login()
	return {
		"user": frappe.utils.get_fullname(frappe.session.user),
		"is_librarian": _is_librarian(),
		"ai_enabled": claude.is_configured(),
		"defaults": _defaults(),
		"countries": COUNTRIES,
		"readers": _readers(),
		"books": _books(),
	}


@frappe.whitelist()
def get_books():
	_require_login()
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
		limit=50,
	)
	titles = {}
	for row in sessions:
		if row.book not in titles:
			titles[row.book] = frappe.db.get_value("Reading Book", row.book, "title") or row.book
		row["book_title"] = titles[row.book]
	return sessions


# --------------------------------------------------------------------------- books


@frappe.whitelist()
def get_book(name):
	_require_login()
	doc = frappe.get_doc("Reading Book", name)
	if not _is_librarian() and not (doc.status == "Ready" and doc.published):
		frappe.throw(_("That book is not available."), frappe.PermissionError)
	return {
		"name": doc.name,
		"title": doc.title,
		"pdf": doc.pdf,
		"status": doc.status,
		"reading_level": doc.reading_level,
		"summary": doc.summary,
		"page_count": doc.page_count,
		"lines": [
			{"page": line.page_no or 1, "text": line.text, "x": line.x, "y": line.y, "w": line.w, "h": line.h}
			for line in doc.lines
			if not line.skip and (line.text or "").strip()
		],
		"tricky_words": [{"word": w.word, "say": w.say, "meaning": w.meaning} for w in doc.tricky_words],
	}


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

	if cover and str(cover).startswith("data:image/jpeg;base64,"):
		try:
			image = base64.b64decode(str(cover).split(",", 1)[1])
			if len(image) <= 600 * 1024:
				file_doc = frappe.get_doc(
					{
						"doctype": "File",
						"file_name": f"{doc.name}-cover.jpg",
						"content": image,
						"is_private": 0,
						"attached_to_doctype": "Reading Book",
						"attached_to_name": doc.name,
						"attached_to_field": "cover_image",
					}
				)
				file_doc.insert(ignore_permissions=True)
				doc.cover_image = file_doc.file_url
		except Exception:
			# A cover is a nicety; never fail the book over it.
			frappe.log_error(title="ES Reading: cover image not saved")

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
	helped = [frappe.utils.strip_html(str(w))[:40] for w in (data.get("helped_words") or [])][:200]
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

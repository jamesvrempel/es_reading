"""Claude API integration: book preparation, text extraction for scanned PDFs, session feedback.

Speech (reading aloud and listening) happens in the browser. Claude is used for the text work only,
and the API key never leaves the server.
"""

import base64
import json
import re

import frappe
import requests
from frappe.utils import cint, flt

API_URL = "https://api.anthropic.com/v1/messages"
API_VERSION = "2023-06-01"
DEFAULT_MODEL = "claude-sonnet-5-5"


class ClaudeError(Exception):
	pass


def _settings():
	return frappe.get_single("ES Reading Settings")


def _api_key():
	try:
		return _settings().get_password("anthropic_api_key", raise_exception=False)
	except Exception:
		return None


def is_configured():
	return bool(cint(_settings().enable_ai) and _api_key())


def call(system, content, max_tokens=2000, timeout=120):
	"""Send one message to Claude and return the text of the reply."""
	key = _api_key()
	if not key:
		raise ClaudeError("No Claude API key is set in ES Reading Settings.")
	payload = {
		"model": _settings().claude_model or DEFAULT_MODEL,
		"max_tokens": max_tokens,
		"system": system,
		"messages": [{"role": "user", "content": content}],
	}
	try:
		response = requests.post(
			API_URL,
			headers={"x-api-key": key, "anthropic-version": API_VERSION, "content-type": "application/json"},
			json=payload,
			timeout=timeout,
		)
	except requests.RequestException as e:
		raise ClaudeError(f"Could not reach the Claude API: {e}") from e
	if response.status_code != 200:
		try:
			message = response.json().get("error", {}).get("message") or response.text
		except Exception:
			message = response.text
		raise ClaudeError(f"Claude API returned {response.status_code}: {message[:300]}")
	data = response.json()
	return "".join(block.get("text", "") for block in data.get("content", []) if block.get("type") == "text")


def parse_json(text):
	"""Pull the first JSON object out of a reply (tolerates code fences and stray prose)."""
	text = (text or "").strip()
	text = re.sub(r"^```(?:json)?\s*|\s*```$", "", text)
	start, end = text.find("{"), text.rfind("}")
	if start == -1 or end <= start:
		raise ClaudeError("Claude did not return JSON.")
	try:
		return json.loads(text[start : end + 1])
	except ValueError as e:
		raise ClaudeError(f"Claude returned invalid JSON: {e}") from e


@frappe.whitelist()
def test_connection():
	frappe.only_for("System Manager")
	try:
		reply = call("Reply with the single word: ready", "Are you there?", max_tokens=20, timeout=30)
	except ClaudeError as e:
		return {"ok": False, "message": str(e)}
	return {"ok": True, "message": reply.strip()}


# --------------------------------------------------------------------------- book preparation

PREPARE_SYSTEM = """You prepare reading material for a read-aloud app used by children aged 6 and up.
You are given the numbered lines of one document. Reply with one JSON object and nothing else:
{
  "reading_level": "short label such as 'Age 7-8'",
  "summary": "one friendly sentence a child would understand, saying what the text is about",
  "skip_lines": [line numbers that should NOT be read aloud: page numbers, headers and footers,
                 name/date/score blanks, answer keys and notes addressed to teachers or parents],
  "tricky_words": [{"word": "as it appears in the text, lower case unless a proper noun",
                    "say": "syllables separated by hyphens, e.g. eu-ca-lyp-tus",
                    "meaning": "what it means in this text, in at most 12 very simple words"}],
  "questions": [{"question": "a short question about what happens in the text",
                 "options": ["three short answers", "only one of them right", "all plausible"],
                 "answer": 0}]
}
Write four questions a child could answer after reading the readable lines once: three about what
happened and one about why. "answer" is the position (0, 1 or 2) of the right option; vary it.
Choose up to 20 tricky words: the ones a child at this level is most likely to stumble on (long,
irregularly spelt, or unfamiliar). Keep story text, questions and instructions for the child as readable."""


def prepare_book(book):
	"""Background job: ask Claude for the reading level, lines to skip and tricky words."""
	doc = frappe.get_doc("Reading Book", book)
	lines = [line for line in doc.lines if (line.text or "").strip()]
	if not lines or not is_configured():
		return
	title = doc.title
	sent = [(line.idx, line.text.strip()) for line in lines]
	numbered = "\n".join(f"{idx}: {text}" for idx, text in sent)

	# The Claude call can take a minute. End the transaction first so the answer is applied to the
	# record as it is afterwards, not to a stale snapshot (which fails if the book changed meanwhile).
	frappe.db.commit()
	try:
		result = parse_json(call(PREPARE_SYSTEM, f"Title: {title}\n\n{numbered}", max_tokens=6000, timeout=180))
	except ClaudeError as e:
		frappe.log_error(title="ES Reading: book preparation failed", message=str(e))
		frappe.db.set_value("Reading Book", book, "note", str(e)[:500])
		frappe.db.commit()
		return

	frappe.db.rollback()
	if not frappe.db.exists("Reading Book", book):
		return
	doc = frappe.get_doc("Reading Book", book)
	if [(line.idx, (line.text or "").strip()) for line in doc.lines if (line.text or "").strip()] != sent:
		return  # the book was re-scanned while Claude was working; that scan queued its own preparation

	skip = {cint(n) for n in result.get("skip_lines") or []}
	for line in doc.lines:
		if line.idx in skip:
			line.skip = 1
	doc.set("tricky_words", [])
	seen = set()
	for item in (result.get("tricky_words") or [])[:25]:
		word = (item.get("word") or "").strip()[:60]
		if not word or word.lower() in seen:
			continue
		seen.add(word.lower())
		doc.append(
			"tricky_words",
			{"word": word, "say": (item.get("say") or "").strip()[:80], "meaning": (item.get("meaning") or "").strip()[:200]},
		)
	questions = []
	for item in (result.get("questions") or [])[:6]:
		options = [str(o).strip()[:140] for o in (item.get("options") or [])][:3]
		answer = cint(item.get("answer"))
		if (item.get("question") or "").strip() and len(options) == 3 and all(options) and 0 <= answer <= 2:
			questions.append({"question": item["question"].strip()[:300], "option_a": options[0], "option_b": options[1], "option_c": options[2], "correct": "ABC"[answer]})
	if questions:
		doc.set("questions", questions)
	doc.reading_level = (result.get("reading_level") or doc.reading_level or "")[:60]
	doc.summary = (result.get("summary") or doc.summary or "")[:300]
	doc.ai_prepared = 1
	doc.note = ""
	doc.flags.cover_from_scan = True
	doc.save(ignore_permissions=True)
	frappe.db.commit()


EXTRACT_SYSTEM = """You transcribe documents for a children's read-aloud app. The PDF has no text layer.
Reply with one JSON object and nothing else:
{"pages": [{"page": 1, "lines": ["first line of text exactly as printed", "second line", ...]}]}
Transcribe every page in reading order, one entry per printed line, keeping the original wording,
spelling and punctuation. Do not describe pictures. Use an empty list for a page with no text."""


def extract_text(book):
	"""Background job: transcribe a scanned PDF with Claude, then prepare it."""
	doc = frappe.get_doc("Reading Book", book)
	try:
		file_doc = frappe.get_doc("File", {"file_url": doc.pdf})
		pdf = base64.b64encode(file_doc.get_content()).decode()
		content = [
			{"type": "document", "source": {"type": "base64", "media_type": "application/pdf", "data": pdf}},
			{"type": "text", "text": "Transcribe this document."},
		]
		frappe.db.commit()  # don't hold a snapshot open across the long Claude call
		result = parse_json(call(EXTRACT_SYSTEM, content, max_tokens=16000, timeout=600))
	except Exception as e:
		frappe.log_error(title="ES Reading: text extraction failed", message=frappe.get_traceback())
		frappe.db.rollback()
		frappe.db.set_value("Reading Book", book, {"status": "Error", "note": str(e)[:500]})
		frappe.db.commit()
		return

	frappe.db.rollback()
	if not frappe.db.exists("Reading Book", book):
		return
	doc = frappe.get_doc("Reading Book", book)
	doc.flags.cover_from_scan = True

	doc.set("lines", [])
	for page in result.get("pages") or []:
		for text in page.get("lines") or []:
			text = (text or "").strip()
			if text:
				doc.append("lines", {"page_no": cint(page.get("page")) or 1, "text": text[:1000]})
	doc.status = "Ready" if doc.lines else "Error"
	doc.note = "" if doc.lines else "No text could be found in this PDF."
	doc.save(ignore_permissions=True)
	frappe.db.commit()
	if doc.lines:
		prepare_book(book)


# --------------------------------------------------------------------------- feedback

FEEDBACK_SYSTEM = """You are a warm, encouraging reading coach inside a read-aloud app for children aged 6 and up.
You are given the numbers from one reading session. Write:
- two short sentences spoken to the child, in very simple words, praising effort and naming one
  specific thing from the session (never a criticism, never the child's name);
- then a new line starting "Grown-ups:" with one practical tip of at most 25 words.
Plain text only."""


def fallback_feedback(session):
	helped = cint(session.words_helped)
	if session.mode == "Listen":
		return "Lovely listening! Next time, try reading it together."
	if helped == 0:
		return "Wonderful reading! You read every word by yourself."
	if helped <= 3:
		return f"Great reading! You only needed help with {helped} word{'s' if helped != 1 else ''}."
	return "Well done for finishing! The tricky words get easier every time you practise."


def session_feedback(session):
	"""Return a short piece of feedback for a finished session (Claude if configured, otherwise canned)."""
	if not is_configured():
		return fallback_feedback(session)
	facts = {
		"book": frappe.db.get_value("Reading Book", session.book, "title"),
		"mode": session.mode,
		"words_read": cint(session.words_total),
		"child_seconds": round(flt(session.reader_seconds)),
		"narrator_seconds": round(flt(session.narrator_seconds)),
		"child_slower_than_narrator_percent": round(flt(session.gap_percent)),
		"words_needing_help": [w for w in (session.helped_words or "").split(", ") if w][:15],
	}
	try:
		return call(FEEDBACK_SYSTEM, json.dumps(facts), max_tokens=250, timeout=25).strip()[:800]
	except ClaudeError as e:
		frappe.log_error(title="ES Reading: feedback failed", message=str(e))
		return fallback_feedback(session)

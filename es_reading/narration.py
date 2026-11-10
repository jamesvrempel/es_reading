"""Recorded narrator voice: each sentence of a book is synthesised once and stored as an MP3.

The browser decides the sentences (it already splits the text for reading aloud) and sends them
here; clips are keyed by a hash of the sentence so the browser can find them again. Any sentence
without a clip is simply read by the device's own voice.
"""

import json
import os
import re
import shutil
import time
from xml.sax.saxutils import escape

import frappe
import requests
from frappe.utils import cint, flt

VOICES = {
	("Australia", "Female"): "en-AU-NatashaNeural",
	("Australia", "Male"): "en-AU-WilliamNeural",
	("United Kingdom", "Female"): "en-GB-SoniaNeural",
	("United Kingdom", "Male"): "en-GB-RyanNeural",
	("United States", "Female"): "en-US-JennyNeural",
	("United States", "Male"): "en-US-GuyNeural",
	("New Zealand", "Female"): "en-NZ-MollyNeural",
	("New Zealand", "Male"): "en-NZ-MitchellNeural",
	("Ireland", "Female"): "en-IE-EmilyNeural",
	("Ireland", "Male"): "en-IE-ConnorNeural",
	("Canada", "Female"): "en-CA-ClaraNeural",
	("Canada", "Male"): "en-CA-LiamNeural",
	("South Africa", "Female"): "en-ZA-LeahNeural",
	("South Africa", "Male"): "en-ZA-LukeNeural",
	("India", "Female"): "en-IN-NeerjaNeural",
	("India", "Male"): "en-IN-PrabhatNeural",
}
OUTPUT_FORMAT = "audio-24khz-48kbitrate-mono-mp3"  # constant bit rate, so length follows from size
BYTES_PER_SECOND = 48000 / 8
FOLDER = "es_reading_narration"


class NarrationError(Exception):
	pass


def _settings():
	return frappe.get_single("ES Reading Settings")


def _key():
	try:
		return _settings().get_password("azure_speech_key", raise_exception=False)
	except Exception:
		return None


def is_configured():
	settings = _settings()
	return bool(settings.narrator_provider == "Azure Speech" and (settings.azure_speech_region or "").strip() and _key())


def voice_for(country, gender):
	return VOICES.get((country, gender)) or VOICES[("Australia", "Female")]


def text_key(text):
	"""Hash of a sentence, computed the same way in the browser (FNV-1a over UTF-16 code units)."""
	data = re.sub(r"\s+", " ", str(text)).strip().lower().encode("utf-16-le")
	out = []
	for seed in (0x811C9DC5, 0x01000193):
		h = seed
		for i in range(0, len(data), 2):
			h ^= data[i] | (data[i + 1] << 8)
			h = (h * 0x01000193) & 0xFFFFFFFF
		out.append(f"{h:08x}")
	return "".join(out)


def synthesize(text, voice):
	"""One sentence to MP3 bytes through the Azure Speech REST API."""
	region = re.sub(r"[^a-z0-9]", "", (_settings().azure_speech_region or "").lower())
	lang = "-".join(voice.split("-")[:2])
	ssml = f"<speak version='1.0' xml:lang='{lang}'><voice name='{voice}'>{escape(text)}</voice></speak>"
	for attempt in range(4):
		try:
			response = requests.post(
				f"https://{region}.tts.speech.microsoft.com/cognitiveservices/v1",
				headers={
					"Ocp-Apim-Subscription-Key": _key() or "",
					"Content-Type": "application/ssml+xml",
					"X-Microsoft-OutputFormat": OUTPUT_FORMAT,
					"User-Agent": "es_reading",
				},
				data=ssml.encode("utf-8"),
				timeout=60,
			)
		except requests.RequestException as e:
			raise NarrationError(f"Could not reach Azure Speech: {e}") from e
		if response.status_code == 200 and response.content:
			return response.content
		if response.status_code == 429 and attempt < 3:  # the free tier allows only a few requests a minute
			time.sleep(min(cint(response.headers.get("Retry-After")) or 20, 60))
			continue
		raise NarrationError(f"Azure Speech returned {response.status_code}: {response.text[:200]}")
	raise NarrationError("Azure Speech kept asking to slow down.")


def _folder(book, voice):
	return frappe.get_site_path("public", "files", FOLDER, re.sub(r"[^A-Za-z0-9_-]", "", book), re.sub(r"[^A-Za-z0-9_-]", "", voice))


def _clips(doc):
	try:
		clips = json.loads(doc.clips or "{}")
		return clips if isinstance(clips, dict) else {}
	except ValueError:
		return {}


def get_doc_for(book, voice, create=False):
	name = frappe.db.get_value("Reading Narration", {"book": book, "voice": voice})
	if name:
		return frappe.get_doc("Reading Narration", name)
	if not create:
		return None
	return frappe.get_doc({"doctype": "Reading Narration", "book": book, "voice": voice, "status": "Queued", "clips": "{}"}).insert(
		ignore_permissions=True
	)


def record(narration, sentences):
	"""Background job: synthesise every sentence that has no clip yet."""
	doc = frappe.get_doc("Reading Narration", narration)
	clips = _clips(doc)
	folder = _folder(doc.book, doc.voice)
	os.makedirs(folder, exist_ok=True)
	pause = flt(frappe.conf.get("es_reading_narration_pause", 3.2))  # stay under the free tier's request rate
	characters = cint(doc.characters)
	doc.db_set({"status": "Recording", "note": ""})
	frappe.db.commit()
	try:
		for text in sentences:
			key = text_key(text)
			if key in clips and os.path.exists(os.path.join(folder, key + ".mp3")):
				continue
			audio = synthesize(text, doc.voice)
			with open(os.path.join(folder, key + ".mp3"), "wb") as f:
				f.write(audio)
			book_part, voice_part = folder.split(os.sep)[-2:]
			clips[key] = {"u": f"/files/{FOLDER}/{book_part}/{voice_part}/{key}.mp3", "s": round(len(audio) / BYTES_PER_SECOND, 2)}
			characters += len(text)
			frappe.db.set_value(
				"Reading Narration", doc.name, {"clips": json.dumps(clips, separators=(",", ":")), "clip_count": len(clips), "characters": characters}
			)
			frappe.db.commit()
			if pause:
				time.sleep(pause)
	except Exception as e:
		frappe.db.rollback()
		frappe.log_error(title="ES Reading: narration recording failed", message=frappe.get_traceback())
		frappe.db.set_value("Reading Narration", doc.name, {"status": "Error", "note": str(e)[:500]})
		frappe.db.commit()
		return
	frappe.db.set_value("Reading Narration", doc.name, {"status": "Ready", "note": ""})
	frappe.db.commit()


def delete_for_book(book):
	"""Remove every narration and its audio files for a book."""
	for name in frappe.get_all("Reading Narration", filters={"book": book}, pluck="name"):
		frappe.delete_doc("Reading Narration", name, ignore_permissions=True, force=True)
	folder = frappe.get_site_path("public", "files", FOLDER, re.sub(r"[^A-Za-z0-9_-]", "", book))
	if os.path.isdir(folder):
		shutil.rmtree(folder, ignore_errors=True)

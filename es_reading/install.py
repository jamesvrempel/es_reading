import frappe

DEFAULTS = {
	"enable_ai": 1,
	"claude_model": "claude-sonnet-5-5",
	"lines_per_turn": 10,
	"silence_seconds": 4,
	"gap_percent": 20,
	"voice_country": "Australia",
	"voice_gender": "Female",
	"speech_rate": 0.9,
	"tricky_word_length": 8,
	"max_readers": 6,
	"max_pdf_mb": 30,
}


def after_install():
	if not frappe.db.exists("Role", "Reading Librarian"):
		frappe.get_doc({"doctype": "Role", "role_name": "Reading Librarian", "desk_access": 1}).insert(
			ignore_permissions=True
		)
	settings = frappe.get_single("ES Reading Settings")
	for key, value in DEFAULTS.items():
		if not settings.get(key):
			settings.set(key, value)
	settings.save(ignore_permissions=True)

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


ROLES = {
	"Reading Librarian": 1,  # manages books; may use the Desk
	"Reading Teacher": 0,  # manages classes at /reading only
}


def ensure_roles():
	"""Create the app's roles. Runs on install and after every migrate, so upgrades get new roles too."""
	for role, desk_access in ROLES.items():
		if not frappe.db.exists("Role", role):
			frappe.get_doc({"doctype": "Role", "role_name": role, "desk_access": desk_access}).insert(ignore_permissions=True)


def after_install():
	ensure_roles()
	settings = frappe.get_single("ES Reading Settings")
	for key, value in DEFAULTS.items():
		if not settings.get(key):
			settings.set(key, value)
	settings.save(ignore_permissions=True)

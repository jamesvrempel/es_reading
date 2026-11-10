import frappe

from es_reading import __version__

no_cache = 1


def get_context(context):
	if frappe.session.user == "Guest":
		frappe.local.flags.redirect_location = "/login?redirect-to=/reading"
		raise frappe.Redirect(302)
	context.no_cache = 1
	context.csrf_token = frappe.sessions.get_csrf_token()
	frappe.db.commit()
	context.app_version = __version__
	return context

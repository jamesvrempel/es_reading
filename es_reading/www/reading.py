import html

import frappe
from frappe.utils import cint

from es_reading import __version__

no_cache = 1


def get_context(context):
	guest = frappe.session.user == "Guest"
	if guest and not cint(frappe.db.get_single_value("ES Reading Settings", "allow_guests")):
		frappe.local.flags.redirect_location = "/login?redirect-to=/reading"
		raise frappe.Redirect(302)
	context.no_cache = 1
	context.csrf_token = ""
	if not guest:
		context.csrf_token = frappe.sessions.get_csrf_token()
		frappe.db.commit()
	context.app_version = __version__
	context.update(site_menu())
	return context


def site_menu():
	"""The website's own top menu (Website Settings), so /reading carries the same navigation."""
	out = {"site_items_left": [], "site_items_right": [], "site_brand_html": "", "site_search": 0, "site_favicon": ""}
	try:
		from frappe.website.doctype.website_settings.website_settings import get_website_settings

		settings = get_website_settings()
	except Exception:
		frappe.log_error(title="ES Reading: site menu not loaded")
		settings = frappe._dict()

	def link(item):
		# Frappe stores these values HTML-escaped; unescape here and let the template escape once.
		return {
			"label": html.unescape(item.get("label") or ""),
			"url": html.unescape(item.get("url") or "#"),
			"new_tab": cint(item.get("open_in_new_tab")),
			"active": (item.get("url") or "").rstrip("/") == "/reading",
		}

	for item in settings.get("top_bar_items") or []:
		if item.get("parent_label") or not item.get("label"):
			continue
		entry = link(item)
		entry["children"] = []
		for child in item.get("child_items") or []:
			child_link = link(child)
			if child_link["label"] and child_link not in entry["children"]:
				entry["children"].append(child_link)
		out["site_items_right" if cint(item.get("right")) else "site_items_left"].append(entry)

	if settings.get("brand_html"):
		out["site_brand_html"] = settings.get("brand_html")
	elif settings.get("banner_image"):
		out["site_brand_html"] = '<img src="{}" alt="">'.format(frappe.utils.escape_html(settings.get("banner_image")))
	else:
		out["site_brand_html"] = frappe.utils.escape_html(
			frappe.db.get_single_value("Website Settings", "app_name") or "Home"
		)
	out["site_search"] = cint(settings.get("navbar_search"))
	out["site_favicon"] = settings.get("favicon") or ""

	user = frappe.session.user
	out["site_user"] = None
	if user == "Guest":
		return out
	full_name = frappe.utils.get_fullname(user) or user
	out["site_user"] = {
		"full_name": full_name,
		"initials": "".join(part[0] for part in full_name.split()[:2]).upper() or "?",
		"image": frappe.db.get_value("User", user, "user_image") or "",
		"is_desk_user": frappe.db.get_value("User", user, "user_type") == "System User",
	}
	return out

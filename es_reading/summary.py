"""Weekly email to each family: what their readers read, and what to practise."""

import frappe
from frappe import _
from frappe.utils import add_days, cint, escape_html, get_url, now_datetime

READ_MODES = ("Read Together", "Re-read")
PREF_KEY = "es_reading_weekly_email"


def family_wants_email(user):
	return frappe.defaults.get_user_default(PREF_KEY, user) != "0"


def reader_week(reader, since):
	sessions = frappe.get_all(
		"Reading Session",
		filters={"reader": reader.name, "status": "Completed", "completed_on": (">=", since)},
		fields=["book", "mode", "reader_seconds", "helped_words", "quiz_correct", "quiz_total"],
	)
	if not sessions:
		return None
	reads = [s for s in sessions if s.mode in READ_MODES]
	titles = []
	for book in dict.fromkeys(s.book for s in reads):
		titles.append(frappe.db.get_value("Reading Book", book, "title") or book)
	helped = {}
	for s in reads:
		for word in (s.helped_words or "").split(", "):
			if word:
				helped[word.lower()] = helped.get(word.lower(), 0) + 1
	return {
		"name": reader.reader_name,
		"sessions": len(sessions),
		"books": titles,
		"minutes": round(sum(s.reader_seconds or 0 for s in reads) / 60),
		"helped": sorted(helped, key=lambda w: -helped[w])[:8],
		"quiz_correct": sum(cint(s.quiz_correct) for s in sessions),
		"quiz_total": sum(cint(s.quiz_total) for s in sessions),
	}


def tip(week):
	if week["helped"]:
		return _("Open My words and practise together for five minutes; a word said correctly three times is counted as known.")
	if week["books"]:
		return _("No help was needed this week. Try a book marked as a challenge next.")
	return _("Listening counts too. Next time, try Read together so the reading is shared.")


def build_summary(user, days=7):
	"""HTML for one family's email, or None when nobody read in the period."""
	since = add_days(now_datetime(), -days)
	readers = frappe.get_all("Reader Profile", filters={"family_user": user}, fields=["name", "reader_name"], order_by="creation asc")
	weeks = [w for w in (reader_week(r, since) for r in readers) if w]
	if not weeks:
		return None
	e = escape_html
	parts = [f"<p>{_('Here is the reading from the last {0} days.').format(days)}</p>"]
	for w in weeks:
		rows = [
			(_("Books read"), e(", ".join(w["books"])) or _("none finished")),
			(_("Time reading aloud"), _("{0} minutes").format(w["minutes"])),
			(_("Words that needed help"), e(", ".join(w["helped"])) or _("none")),
		]
		if w["quiz_total"]:
			rows.append((_("Questions about the story"), _("{0} of {1} right").format(w["quiz_correct"], w["quiz_total"])))
		table = "".join(
			f"<tr><td style='padding:4px 16px 4px 0;color:#5d727a;vertical-align:top'>{label}</td><td style='padding:4px 0'>{value}</td></tr>"
			for label, value in rows
		)
		parts.append(
			f"<h3 style='margin:22px 0 6px;color:#1f3a44'>{e(w['name'])}</h3><table cellpadding='0' cellspacing='0'>{table}</table>"
			f"<p style='margin:8px 0 0'><b>{_('Tip')}:</b> {e(tip(w))}</p>"
		)
	parts.append(
		f"<p style='margin-top:24px'><a href='{get_url('/reading')}'>{_('Open ES Reading')}</a></p>"
		f"<p style='color:#5d727a;font-size:13px'>{_('You can turn this email off on the Who is reading page at ES Reading.')}</p>"
	)
	return "".join(parts)


def send_weekly_summaries():
	"""Scheduled weekly. Does nothing unless the site setting is on."""
	if not cint(frappe.db.get_single_value("ES Reading Settings", "send_weekly_summary")):
		return 0
	sent = 0
	for user in frappe.get_all("Reader Profile", pluck="family_user", distinct=True):
		try:
			if not user or user in ("Guest", "Administrator") or not frappe.db.get_value("User", user, "enabled"):
				continue
			if not family_wants_email(user):
				continue
			html = build_summary(user)
			if html:
				frappe.sendmail(recipients=[user], subject=_("This week's reading"), message=html)
				sent += 1
		except Exception:
			frappe.log_error(title="ES Reading: weekly summary failed")
	return sent


@frappe.whitelist()
def send_sample():
	"""Settings button: email the signed-in administrator their own readers' last 30 days."""
	frappe.only_for("System Manager")
	html = build_summary(frappe.session.user, days=30)
	if not html:
		return {"ok": False, "message": _("Your account has no reading in the last 30 days to summarise.")}
	frappe.sendmail(recipients=[frappe.session.user], subject=_("This week's reading (sample)"), message=html)
	return {"ok": True, "message": _("Sample sent to {0}.").format(frappe.session.user)}

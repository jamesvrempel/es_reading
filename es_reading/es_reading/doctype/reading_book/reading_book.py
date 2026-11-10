import frappe
from frappe.model.document import Document


class ReadingBook(Document):
	def validate(self):
		if not self.is_new() and self.has_value_changed("cover_image") and not self.flags.cover_from_scan:
			self.custom_cover = 1 if self.cover_image else 0
		skipped = skipped_pages(self.skip_pages)
		self.skip_pages = ", ".join(str(n) for n in sorted(skipped))
		readable = [
			line
			for line in self.lines
			if not line.skip and (line.text or "").strip() and (line.page_no or 1) not in skipped
		]
		self.page_count = self.page_count or max([line.page_no or 0 for line in self.lines] or [0])
		self.line_count = len(readable)
		self.word_count = sum(len((line.text or "").split()) for line in readable)


def skipped_pages(value):
	"""Parse the "Pages not read" field into a set of page numbers."""
	pages = set()
	for part in str(value or "").replace(";", ",").split(","):
		part = part.strip()
		if part.isdigit() and 0 < int(part) < 5000:
			pages.add(int(part))
	return pages

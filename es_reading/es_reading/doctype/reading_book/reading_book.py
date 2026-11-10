import frappe
from frappe.model.document import Document


class ReadingBook(Document):
	def validate(self):
		readable = [line for line in self.lines if not line.skip and (line.text or "").strip()]
		self.page_count = self.page_count or max([line.page_no or 0 for line in self.lines] or [0])
		self.line_count = len(readable)
		self.word_count = sum(len((line.text or "").split()) for line in readable)

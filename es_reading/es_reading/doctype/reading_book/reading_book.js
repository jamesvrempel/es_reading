// Reading Book form: scan the PDF's text here, so a book made in the Desk can be set up without leaving it.

frappe.ui.form.on("Reading Book", {
	refresh(frm) {
		if (frm.is_new()) {
			frm.set_intro(__("Attach the PDF and save. A Scan the PDF button then appears at the top of this form."), "blue");
			return;
		}
		const scanned = (frm.doc.lines || []).length > 0;
		if (frm.doc.pdf) {
			frm.add_custom_button(scanned ? __("Re-scan the PDF") : __("Scan the PDF"), () => es_reading_scan(frm)).addClass(scanned ? "" : "btn-primary");
			if (!scanned) {
				frm.set_intro(__("This book has no text yet, so it cannot be read. Press Scan the PDF at the top right."), "orange");
			}
		} else if (!scanned) {
			frm.set_intro(__("Attach a PDF and save, then press Scan the PDF."), "blue");
		}
		if (scanned && !frm.doc.line_count) {
			frm.set_intro(__("Every page is listed in Pages not read, so there is nothing to read. Clear that field."), "orange");
		}
		frm.add_custom_button(__("Open in ES Reading"), () => window.open("/reading?manage=" + encodeURIComponent(frm.doc.name), "_blank"));
	},
});

function es_reading_scan(frm) {
	if (frm.is_dirty()) {
		frappe.msgprint(__("Save the book first, then scan it."));
		return;
	}
	const assets = ["/assets/es_reading/vendor/pdfjs/pdf.min.js", "/assets/es_reading/js/es_reading_scan.js"];
	frappe.require(assets, async () => {
		frappe.dom.freeze(__("Reading the PDF..."));
		try {
			const found = await window.ESReadingScan.extractPdf(frm.doc.pdf);
			const r = await frappe.call({
				method: "es_reading.api.save_book_content",
				args: { book: frm.doc.name, pages: JSON.stringify(found.pages), page_count: found.pageCount, cover: found.cover },
			});
			const saved = r.message || {};
			frappe.show_alert({
				message: saved.status === "Ready" ? __("Scanned: {0} lines, {1} words.", [saved.lines, saved.words]) : saved.note || saved.status,
				indicator: saved.status === "Ready" ? "green" : "orange",
			}, 7);
			frm.reload_doc();
		} catch (e) {
			console.error(e);
			frappe.msgprint({ title: __("The PDF could not be scanned"), indicator: "red", message: frappe.utils.escape_html(e.message || String(e)) });
		} finally {
			frappe.dom.unfreeze();
		}
	});
}

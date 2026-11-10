frappe.ui.form.on("ES Reading Settings", {
	refresh(frm) {
		frm.add_custom_button(__("Test Claude connection"), () => {
			frappe.call({
				method: "es_reading.claude.test_connection",
				freeze: true,
				freeze_message: __("Asking Claude..."),
				callback(r) {
					const result = r.message || {};
					frappe.msgprint({
						title: result.ok ? __("Connected") : __("Not connected"),
						indicator: result.ok ? "green" : "red",
						message: frappe.utils.escape_html(result.message || ""),
					});
				},
			});
		});
		frm.add_custom_button(__("Open ES Reading"), () => window.open("/reading", "_blank"));
	},
});

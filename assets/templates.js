// Starter templates for new sections. Once a section is created its columns live in the
// Google Sheet and are edited in the app (Customize), so changing this file only affects
// sections created afterwards. `target` on a link column names another template id; it is
// matched to the section created from that template, so a template must come after the
// ones it links to.
(function () {
  'use strict';
  const o = (value, label, color, extra) => Object.assign({ value, label, color }, extra || {});
  const title = (label) => ({ key: 'title', label, type: 'text', required: true, system: true, onCard: true });

  window.TEMPLATES = [
    {
      id: 'suppliers',
      name: 'Supplier Register',
      blurb: 'Suppliers and subcontractors we source from, with category, rating and approval expiry.',
      stageField: 'status',
      fields: [
        title('Supplier name'),
        { key: 'supplierCode', label: 'Supplier code', type: 'text', onCard: true },
        { key: 'category', label: 'Category', type: 'select', onCard: true, options: [o('valves', 'Valves & Piping', 'blue'), o('electrical', 'Electrical & Instrument', 'amber'), o('mechanical', 'Mechanical / HVAC', 'teal'), o('fabrication', 'Fabrication', 'purple'), o('safety', 'Safety & Fire', 'red'), o('services', 'Services / Subcon', 'green'), o('other', 'Others', 'gray')] },
        { key: 'contact', label: 'Contact person', type: 'text' },
        { key: 'email', label: 'Email', type: 'text', onCard: true },
        { key: 'phone', label: 'Phone', type: 'text' },
        { key: 'supplierType', label: 'Type', type: 'select', options: [o('Manufacturer', 'Manufacturer', 'purple'), o('Distributor', 'Distributor', 'blue'), o('Stockist', 'Stockist', 'teal'), o('Agent', 'Agent', 'amber'), o('Supplier', 'Supplier', 'gray')] },
        { key: 'country', label: 'Country', type: 'text', onCard: true },
        { key: 'status', label: 'Status', type: 'select', options: [
          o('evaluation', 'Under Evaluation', 'amber', { alertDays: 14 }),
          o('approved', 'Approved (AVL)', 'green'),
          o('conditional', 'Conditional', 'blue'),
          o('inactive', 'Inactive', 'gray', { done: true }),
          o('blacklisted', 'Blacklisted', 'red', { done: true }),
        ] },
        { key: 'rating', label: 'Rating', type: 'select', onCard: true, options: [o('a', 'A — preferred', 'green'), o('b', 'B — acceptable', 'blue'), o('c', 'C — use with care', 'amber')] },
        { key: 'brands', label: 'Brands / products', type: 'text' },
        { key: 'expiryDate', label: 'Approval / licence expiry', type: 'date', due: true, onCard: true },
        { key: 'website', label: 'Website', type: 'url' },
        { key: 'notes', label: 'Notes', type: 'longtext' },
      ],
    },
  ];

  /** A new section's settings from a template, with link columns pointed at existing sections. */
  window.sectionFromTemplate = function (tpl, sections) {
    const fields = JSON.parse(JSON.stringify(tpl.fields)).map((f) => {
      if (f.type === 'link') {
        const t = sections.find((s) => s.template === f.target && !s.archived);
        f.target = t ? t.id : '';
      }
      return f;
    });
    return { name: tpl.name, template: tpl.id, fields, stageField: tpl.stageField };
  };
})();

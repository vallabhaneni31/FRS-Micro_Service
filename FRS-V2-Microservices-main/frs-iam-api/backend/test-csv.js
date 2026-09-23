const { Readable } = require('stream');
const csv = require('csv-parser');

const templateHeaders = [
  'employee_code', 'first_name', 'last_name', 'email', 'phone',
  'department', 'designation', 'site_id', 'status', 'hire_date'
];

const sampleRows = [
  ['EMP001', 'John', 'Smith', 'john@company.com', '+919999999991', 'Engineering', 'Software Engineer', '1', 'active', '2026-01-15'],
];

const csvStr = [templateHeaders.join(','), ...sampleRows.map(r => r.join(','))].join('\n');
const csvWithBom = '\uFEFF' + csvStr;

const stream = Readable.from(Buffer.from(csvWithBom, 'utf-8').toString());

stream.pipe(csv()).on('data', (row) => {
  console.log("Parsed row:", row);
  if (!row.employee_code || !row.first_name || !row.last_name) {
    console.log("MISSING REQUIRED FIELDS");
  } else {
    console.log("ALL GOOD");
  }
});

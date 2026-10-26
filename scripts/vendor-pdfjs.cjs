const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const src = path.join(root, 'node_modules', 'pdfjs-dist');
const dest = path.join(root, 'src', 'vendor', 'pdfjs');
fs.rmSync(dest, { recursive: true, force: true });
fs.mkdirSync(dest, { recursive: true });
fs.copyFileSync(path.join(src, 'build', 'pdf.js'), path.join(dest, 'pdf.js'));
fs.copyFileSync(path.join(src, 'build', 'pdf.worker.js'), path.join(dest, 'pdf.worker.js'));
for (const dir of ['cmaps', 'standard_fonts']) {
  const from = path.join(src, dir);
  if (fs.existsSync(from)) fs.cpSync(from, path.join(dest, dir), { recursive: true });
}
const license = path.join(src, 'LICENSE');
if (fs.existsSync(license)) fs.copyFileSync(license, path.join(dest, 'LICENSE'));
console.log('Vendored PDF.js to', dest);

const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const src = path.join(root, 'node_modules', 'katex', 'dist');
const dest = path.join(root, 'src', 'vendor', 'katex');
fs.rmSync(dest, { recursive: true, force: true });
fs.mkdirSync(dest, { recursive: true });
fs.copyFileSync(path.join(src, 'katex.mjs'), path.join(dest, 'katex.mjs'));
fs.copyFileSync(path.join(src, 'katex.min.css'), path.join(dest, 'katex.min.css'));
fs.cpSync(path.join(src, 'fonts'), path.join(dest, 'fonts'), { recursive: true });
fs.mkdirSync(path.join(dest, 'contrib'), { recursive: true });
fs.copyFileSync(path.join(src, 'contrib', 'mhchem.mjs'), path.join(dest, 'contrib', 'mhchem.mjs'));
const license = path.join(root, 'node_modules', 'katex', 'LICENSE');
if (fs.existsSync(license)) fs.copyFileSync(license, path.join(dest, 'LICENSE'));
console.log('Vendored KaTeX to', dest);

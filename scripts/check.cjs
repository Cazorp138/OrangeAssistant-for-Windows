'use strict';

/**
 * Lightweight, dependency-free sanity check for CI and for contributors who
 * do not want to launch Electron just to validate a small change.
 */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const root = path.resolve(__dirname, '..');
const failures = [];
let syntaxChecked = 0;
let syntaxSkipped = false;

function fail(message) {
  failures.push(message);
}

function checkSyntax(file) {
  const result = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
  if (result.error?.code === 'EPERM') {
    // Some restricted Windows sandboxes deny spawning a child Node process.
    // GitHub Actions and normal developer shells do not have this restriction.
    syntaxSkipped = true;
    return;
  }
  if (result.status !== 0) {
    const detail = result.stderr || result.stdout || result.error?.message || `exit code ${result.status}`;
    fail(`syntax error in ${path.relative(root, file)}:\n${String(detail).trim()}`);
    return;
  }
  syntaxChecked += 1;
}

function ensureFile(relativePath) {
  const full = path.join(root, relativePath);
  if (!fs.existsSync(full) || !fs.statSync(full).isFile()) {
    fail(`missing file: ${relativePath}`);
  }
}

function collectJavaScript(dir) {
  const found = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'vendor' || entry.name === 'node_modules') continue;
      found.push(...collectJavaScript(full));
    } else if (/\.(?:js|cjs|mjs)$/.test(entry.name)) {
      found.push(full);
    }
  }
  return found;
}

ensureFile('package.json');
ensureFile('package-lock.json');
ensureFile('main.js');
ensureFile('preload.js');
ensureFile('src/app.js');
ensureFile('src/index.html');
ensureFile('src/styles.css');
ensureFile('src/markdown.js');
ensureFile('src/main/store.js');
ensureFile('src/main/pdf.js');
ensureFile('src/main/segment.js');
ensureFile('src/main/ai.js');
ensureFile('build/icon.ico');
ensureFile('build/icon.png');
ensureFile('src/vendor/pdfjs/pdf.js');
ensureFile('src/vendor/pdfjs/pdf.worker.js');
ensureFile('src/vendor/katex/katex.mjs');
ensureFile('src/vendor/katex/katex.min.css');
ensureFile('src/vendor/katex/LICENSE');

try {
  JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
} catch (error) {
  fail(`package.json is not valid JSON: ${error.message}`);
}

const nodeMajor = Number(process.versions.node.split('.')[0]);
if (nodeMajor < 20) fail(`Node.js >= 20 is required (found ${process.version})`);

for (const file of collectJavaScript(path.join(root, 'src'))) checkSyntax(file);
for (const file of ['main.js', 'preload.js', 'scripts/vendor-katex.cjs', 'scripts/vendor-pdfjs.cjs']) {
  const full = path.join(root, file);
  if (fs.existsSync(full)) checkSyntax(full);
}

const secretPatterns = [
  { name: 'possible API key', pattern: /\bsk-[A-Za-z0-9_-]{20,}\b/ },
  { name: 'absolute user path', pattern: /[A-Za-z]:\\Users\\[^\\\s]+/ },
  { name: 'private key block', pattern: /BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY/ },
];
for (const file of collectJavaScript(path.join(root, 'src')).concat([
  path.join(root, 'main.js'),
  path.join(root, 'preload.js'),
])) {
  const text = fs.readFileSync(file, 'utf8');
  for (const secret of secretPatterns) {
    if (secret.pattern.test(text)) fail(`${secret.name} found in ${path.relative(root, file)}`);
  }
}

if (failures.length) {
  console.error('\nOpen-source check failed:\n');
  for (const message of failures) console.error(` - ${message}`);
  process.exit(1);
}

console.log('Open-source check passed.');
console.log(`Node ${process.version} · ${syntaxChecked} JavaScript files syntax-checked · vendored assets present.`);
if (syntaxSkipped) console.log('Note: child-process syntax checks were skipped by this Windows sandbox; CI runs them normally.');

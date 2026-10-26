'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

let pdfjs = null;
function getPdfjs() {
  if (!pdfjs) {
    // The legacy build is the Node-friendly entry and has no browser dependencies.
    pdfjs = require('pdfjs-dist/legacy/build/pdf.js');
  }
  return pdfjs;
}

const CJK = /[\u2E80-\u9FFF\uF900-\uFAFF\uFF00-\uFFEF]/;
const CJK_PUNCT = /[，。、；：！？）】》」』…—～·]/;
const ASCII_ALNUM = /[A-Za-z0-9]/;

function cleanText(value) {
  return String(value || '')
    .replace(/\u0000/g, '−')
    .replace(/\u00a0/g, ' ')
    .replace(/[\u0001-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeKey(value) {
  return cleanText(value).replace(/\s+/g, '').toLowerCase();
}

function joinInline(items) {
  let out = '';
  let prev = null;
  for (const item of items) {
    const text = String(item.str || '');
    if (!text) continue;
    if (!out) {
      out = text;
      prev = item;
      continue;
    }
    const gap = Number(item.x || 0) - Number(prev.x + prev.width || 0);
    const needsSpace = gap > Math.max(1.3, Number(item.height || 0) * 0.16);
    const last = out[out.length - 1];
    const first = text[0];
    let sep = '';
    if (needsSpace && last && first && !/\s/.test(last) && !/\s/.test(first)) {
      if (!(CJK.test(last) && CJK.test(first)) && !CJK_PUNCT.test(last)) sep = ' ';
    }
    out += sep + text;
    prev = item;
  }
  return cleanText(out);
}

function sortLines(a, b) {
  if (Math.abs(a.y - b.y) > 1.2) return b.y - a.y;
  return a.x - b.x;
}

function pageLinesFromItems(items) {
  const usable = [];
  for (const item of items) {
    const str = String(item.str || '');
    if (!str.trim()) continue;
    const transform = item.transform || [];
    // Ignore vertical / rotated decorative text; lecture body is horizontal.
    if (Math.abs(transform[1] || 0) > 0.05 || Math.abs(transform[2] || 0) > 0.05) continue;
    const height = Math.abs(Number(item.height) || Math.hypot(transform[0] || 0, transform[1] || 0) || 10);
    usable.push({
      str,
      x: Number(transform[4]) || 0,
      y: Number(transform[5]) || 0,
      width: Number(item.width) || 0,
      height,
    });
  }

  const lines = [];
  const sorted = usable.sort((a, b) => {
    if (Math.abs(a.y - b.y) > Math.max(1.2, a.height * 0.32)) return b.y - a.y;
    return a.x - b.x;
  });

  for (const item of sorted) {
    const tolerance = Math.max(1.5, Math.min(4, item.height * 0.34));
    let line = lines.find((candidate) => Math.abs(candidate.y - item.y) <= tolerance);
    if (!line) {
      line = { y: item.y, x: item.x, height: item.height, items: [] };
      lines.push(line);
    }
    line.items.push(item);
    line.x = Math.min(line.x, item.x);
    line.height = Math.max(line.height, item.height);
  }

  return lines
    .map((line) => {
      line.items.sort((a, b) => a.x - b.x);
      const text = joinInline(line.items);
      const right = Math.max(...line.items.map((item) => item.x + item.width));
      return {
        text,
        x: line.x,
        y: line.y,
        width: right - line.x,
        height: line.height,
      };
    })
    .filter((line) => line.text && line.text.length > 0)
    .sort(sortLines);
}

function isPageFurniture(text) {
  if (!text) return true;
  if (/^[·•\-–—\s]*\d{1,3}[·•\-–—\s]*$/.test(text)) return true;
  if (/^第\s*\d+\s*页(\s*[/／]\s*共?\s*\d+\s*页)?$/.test(text)) return true;
  if (/^page\s+\d+(\s*(of|\/)\s*\d+)?$/i.test(text)) return true;
  if (/^\d+\s*[/／]\s*\d+$/.test(text)) return true;
  return false;
}

function similarityKey(text) {
  return normalizeKey(text).replace(/[·•\-–—_=*]/g, '').replace(/\d+/g, '#');
}

function extractTitle(meta, pageOneLines, filename) {
  const infoTitle = cleanText(meta && meta.info && meta.info.Title);
  if (infoTitle && infoTitle.length >= 2 && !/^(untitled|microsoft word|document\d*)$/i.test(infoTitle)) {
    return infoTitle.slice(0, 120);
  }
  if (pageOneLines && pageOneLines.length) {
    const big = [...pageOneLines]
      .filter((line) => line.height >= 18 && line.text.length >= 2 && line.text.length <= 70)
      .sort((a, b) => b.height - a.height)
      .slice(0, 2)
      .sort((a, b) => b.y - a.y);
    if (big.length) {
      const title = big.map((line) => line.text).join('').replace(/\s+/g, ' ').trim();
      if (title.length >= 2) return title.slice(0, 120);
    }
  }
  return path.basename(filename, path.extname(filename)).slice(0, 120);
}

/**
 * Extract positioned text lines from every page of a PDF.
 * @param {string} filePath
 * @param {(stage: string, progress: number) => void} [onProgress]
 */
async function extractPdf(filePath, onProgress = () => {}) {
  const data = new Uint8Array(fs.readFileSync(filePath));
  const pdfjsLib = getPdfjs();
  const pdfjsRoot = path.join(__dirname, '..', '..', 'node_modules', 'pdfjs-dist');
  let pdf;
  try {
    pdf = await pdfjsLib.getDocument({
      data,
      isEvalSupported: false,
      disableFontFace: true,
      useSystemFonts: true,
      useWorkerFetch: false,
      cMapUrl: path.join(pdfjsRoot, 'cmaps') + path.sep,
      cMapPacked: true,
      standardFontDataUrl: path.join(pdfjsRoot, 'standard_fonts') + path.sep,
      verbosity: 0,
    }).promise;
  } catch (error) {
    if (error && (error.name === 'PasswordException' || /password/i.test(error.message || ''))) {
      const wrapped = new Error('这份 PDF 设有打开密码，橘前辈暂时读不了。请先导出无密码版本，再重新导入。');
      wrapped.code = 'PDF_PASSWORD';
      throw wrapped;
    }
    const wrapped = new Error('没能打开这份 PDF。它可能已损坏，或使用了暂不支持的格式。');
    wrapped.code = 'PDF_OPEN_FAILED';
    wrapped.cause = error;
    throw wrapped;
  }

  const meta = await pdf.getMetadata().catch(() => ({}));
  const pages = [];
  const pageCount = pdf.numPages;
  for (let pageNumber = 1; pageNumber <= pageCount; pageNumber += 1) {
    const page = await pdf.getPage(pageNumber);
    const viewport = page.getViewport({ scale: 1 });
    const content = await page.getTextContent({ includeMarkedContent: false });
    const lines = pageLinesFromItems(content.items);
    pages.push({
      number: pageNumber,
      width: viewport.width,
      height: viewport.height,
      lines,
    });
    page.cleanup();
    onProgress('extract', Math.min(0.98, pageNumber / pageCount));
  }
  await pdf.destroy().catch(() => {});

  // Remove obvious page numbers and running headers/footers.
  const repeated = new Map();
  for (const page of pages) {
    for (const line of page.lines) {
      if (line.text.length > 80) continue;
      const key = similarityKey(line.text);
      if (!key) continue;
      if (!repeated.has(key)) repeated.set(key, new Set());
      repeated.get(key).add(page.number);
    }
  }

  const filteredPages = pages.map((page) => {
    const lines = page.lines.filter((line) => {
      if (isPageFurniture(line.text)) return false;
      const atTop = line.y > page.height * 0.91;
      const atBottom = line.y < page.height * 0.075;
      const key = similarityKey(line.text);
      const repeatCount = key ? (repeated.get(key) || new Set()).size : 0;
      if ((atTop || atBottom) && line.text.length <= 80 && repeatCount >= Math.max(2, Math.ceil(pageCount * 0.5))) {
        return false;
      }
      // A repeated small line near the top is a running subtitle or header, not content.
      if (
        line.y > page.height * 0.78 &&
        line.height <= 10.5 &&
        line.text.length <= 70 &&
        repeatCount >= Math.max(2, Math.ceil(pageCount * 0.5))
      ) {
        return false;
      }
      if (atBottom && line.height <= 10 && line.text.length < 100) return false;
      return true;
    });
    return { ...page, lines };
  });

  const charCount = filteredPages.reduce(
    (sum, page) => sum + page.lines.reduce((s, line) => s + line.text.length, 0),
    0,
  );
  if (charCount < 20) {
    const error = new Error('这份 PDF 里几乎没有可提取的文字，可能是扫描图片版。橘前辈暂时还不能识别图片文字，建议先做 OCR，或导入可复制文字的 PDF。');
    error.code = 'PDF_NO_TEXT';
    throw error;
  }

  const title = extractTitle(meta, filteredPages[0] ? filteredPages[0].lines : [], filePath);
  return {
    title,
    pageCount,
    pages: filteredPages,
    charCount,
    metadata: {
      title,
      author: cleanText(meta && meta.info && meta.info.Author),
      creator: cleanText(meta && meta.info && meta.info.Creator),
    },
    hash: crypto.createHash('sha1').update(data).digest('hex').slice(0, 16),
  };
}

module.exports = { extractPdf, cleanText, normalizeKey };

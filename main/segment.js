'use strict';

const { cleanText } = require('./pdf');

const CJK = /[\u2E80-\u9FFF\uF900-\uFAFF\uFF00-\uFFEF]/;
const CHAPTER_RE = /^(第\s*[一二三四五六七八九十百千万两0-9０-９]+\s*[章讲篇]|第\s*[一二三四五六七八九十百千万两0-9０-９]+\s*部分|(?:Chapter|CHAPTER|Part|PART|Lecture|LECTURE)\s+[0-9IVXLC]+)/;
const SECTION_RE = /^\d{1,2}(?:[.．]\d{1,2}){1,3}\s*[、.．:：\-—]?/;
const EXAMPLE_RE = /^((?:例\s*题?|例)\s*[0-9０-９一二三四五六七八九十]+|【\s*例\s*题?\s*[^】]*】|(?:典型)?例题|Example\s*\d+)/i;

function median(values) {
  const sorted = values.filter((value) => Number.isFinite(value)).sort((a, b) => a - b);
  if (!sorted.length) return 0;
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function charCount(text) {
  return (String(text || '').match(/[\u4e00-\u9fffA-Za-z0-9]/g) || []).length;
}

function isCjkChar(char) {
  return !!char && CJK.test(char);
}

function smartJoin(prev, next) {
  if (!prev) return next;
  if (!next) return prev;
  const left = prev[prev.length - 1];
  const right = next[0];
  if (!left || !right) return prev + next;
  if (/\s$/.test(prev) || /^\s/.test(next)) return prev + next;
  if (/[-‐‑]\s*$/.test(prev) && /^[a-z]/i.test(next)) return prev.replace(/[-‐‑]\s*$/, '') + next;
  if (isCjkChar(left) && isCjkChar(right)) return prev + next;
  if (/[，。、；：！？,.;:!?）】》」』…—]$/.test(left)) return prev + next;
  if (/[A-Za-z0-9]/.test(left) && /[A-Za-z0-9]/.test(right)) return prev + ' ' + next;
  if (isCjkChar(left) || isCjkChar(right)) return prev + next;
  return prev + ' ' + next;
}

function mergeLines(lines) {
  let text = '';
  for (const line of lines) text = smartJoin(text, cleanText(line.text));
  return text.trim();
}

function isChapterHeading(line, bodySize) {
  const text = cleanText(line.text);
  if (!text || text.length > 80) return false;
  if (EXAMPLE_RE.test(text)) return false;
  if (/\s+\d{1,3}$/.test(text) && text.length <= 70) return false;
  if (CHAPTER_RE.test(text)) return true;
  return line.height >= bodySize * 1.55 && text.length <= 34 && !/[。；，、]$/.test(text);
}

function isNumberedSection(text) {
  return SECTION_RE.test(cleanText(text));
}

function isTitleContinuation(line, baseLine, bodySize, allowChapterLike = false) {
  const text = cleanText(line.text);
  if (!text || text.length > 64) return false;
  if (line.page !== baseLine.page) return false;
  if (isChapterHeading(line, bodySize) && !allowChapterLike) return false;
  if (isNumberedSection(text) || EXAMPLE_RE.test(text)) return false;
  if (baseLine.y - line.y < -2 || baseLine.y - line.y > Math.max(bodySize * 3.2, 38)) return false;
  if (line.height < bodySize * 1.02) return false;
  if (/[。；;]$/.test(text)) return false;
  return true;
}

function mergeHeadingFragments(lines, bodySize) {
  const output = [];
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const text = cleanText(line.text);
    const chapterMatch = text.match(CHAPTER_RE);
    const chapterMissingTitle = Boolean(chapterMatch) &&
      text.slice(chapterMatch[0].length).replace(/^[\s　:：、.．\-—]+/, '').trim() === '';
    if (!chapterMissingTitle) {
      output.push(line);
      continue;
    }
    let combined = text;
    let consumed = 0;
    while (consumed < 2 && i + 1 + consumed < lines.length) {
      const next = lines[i + 1 + consumed];
      if (!isTitleContinuation(next, line, bodySize, true)) break;
      const nextText = cleanText(next.text);
      combined = smartJoin(combined, nextText);
      consumed += 1;
      if (/[。！？!?；;]$/.test(nextText)) break;
    }
    output.push(consumed ? { ...line, text: combined } : line);
    i += consumed;
  }
  return output;
}

function stripChapterNumber(text) {
  const value = cleanText(text);
  const match = value.match(CHAPTER_RE);
  if (!match) return { number: '', title: value };
  const number = cleanText(match[0]).replace(/\s+/g, '');
  const title = value.slice(match[0].length).replace(/^[\s　:：、.．\-—]+/, '').trim();
  return { number, title };
}

function makeChaptersFromStarts(flow, starts, bodySize) {
  const chapters = [];
  starts.forEach((start, index) => {
    const heading = flow[start];
    const end = index + 1 < starts.length ? starts[index + 1] : flow.length;
    const content = flow.slice(start + 1, end);
    const display = cleanText(heading.text);
    const parsed = stripChapterNumber(display);
    const title = parsed.title || parsed.number || `第 ${index + 1} 部分`;
    const preview = mergeLines(content).slice(0, 2600);
    chapters.push({
      id: `c${index + 1}`,
      number: parsed.number,
      title,
      displayTitle: cleanText(parsed.number ? `${parsed.number}　${title}` : title),
      page: heading.page,
      pageEnd: content.length ? content[content.length - 1].page : heading.page,
      preview,
    });
  });
  return chapters;
}

function chunkFlow(flow, targetChars = 2400) {
  const chunks = [];
  let current = [];
  let count = 0;
  for (const line of flow) {
    current.push(line);
    count += charCount(line.text);
    if (count >= targetChars) {
      chunks.push(current);
      current = [];
      count = 0;
    }
  }
  if (current.length) chunks.push(current);
  return chunks;
}

/**
 * Chapters are the only structure we need now; the original PDF remains the
 * reading surface. Keep this intentionally conservative to avoid cutting a
 * heading into fragments.
 */
function buildBook(extraction, meta = {}) {
  const pages = extraction.pages || [];
  const allLines = [];
  for (const page of pages) {
    for (const line of page.lines) allLines.push({ ...line, page: page.number });
  }

  const bodySize = median(
    allLines.filter((line) => charCount(line.text) >= 8).map((line) => line.height),
  ) || median(allLines.map((line) => line.height)) || 10;

  const firstPage = pages[0];
  const firstMax = firstPage ? Math.max(0, ...firstPage.lines.map((line) => line.height)) : 0;
  const firstText = (firstPage?.lines || []).map((line) => cleanText(line.text)).join(' ');
  const firstContentLines = (firstPage?.lines || []).filter((line) => charCount(line.text) >= 6).length;
  const firstHasExample = (firstPage?.lines || []).some((line) => EXAMPLE_RE.test(cleanText(line.text)));
  const looksLikeCover =
    firstMax >= Math.max(20, bodySize * 1.85) &&
    !firstHasExample &&
    !/\d{1,2}[.．]\d{1,2}/.test(firstText) &&
    (/目\s*录|contents/i.test(firstText) || firstContentLines <= 7);
  const skipFirstPage = pages.length > 1 && looksLikeCover;

  let flow = [];
  for (const page of pages) {
    if (skipFirstPage && page.number === 1) continue;
    for (const line of page.lines) flow.push({ ...line, page: page.number });
  }
  flow = mergeHeadingFragments(flow, bodySize);

  if (!flow.length) {
    const error = new Error('PDF 没有可阅读的正文。');
    error.code = 'PDF_EMPTY_BODY';
    throw error;
  }

  let starts = [];
  flow.forEach((line, index) => {
    if (isChapterHeading(line, bodySize)) starts.push(index);
  });

  if (!starts.length) {
    const big = [];
    flow.forEach((line, index) => {
      const text = cleanText(line.text);
      if (line.height >= bodySize * 1.45 && text.length <= 42 && !EXAMPLE_RE.test(text)) big.push(index);
    });
    starts = big;
  }

  let chapters = [];
  if (starts.length) {
    chapters = makeChaptersFromStarts(flow, starts, bodySize);
    // Front matter before the first chapter becomes a chapter only when it is
    // substantial; otherwise it is just cover/contents noise.
    if (starts[0] > 0) {
      const preface = flow.slice(0, starts[0]);
      const text = mergeLines(preface);
      if (text.length >= 120 && !/目录|contents/i.test(text)) {
        chapters.unshift({
          id: '',
          number: '',
          title: '前言',
          displayTitle: '前言',
          page: preface[0].page,
          pageEnd: preface[preface.length - 1].page,
          preview: text.slice(0, 2600),
        });
      }
    }
  } else {
    const chunks = chunkFlow(flow);
    chapters = chunks.map((chunk, index) => {
      const first = chunk[0];
      const title = `第 ${index + 1} 部分`;
      return {
        id: '',
        number: '',
        title,
        displayTitle: title,
        page: first.page,
        pageEnd: chunk[chunk.length - 1].page,
        preview: mergeLines(chunk).slice(0, 2600),
      };
    });
    if (chapters.length) chapters[0].title = chapters[0].displayTitle = `第 1 部分 · ${mergeLines(flow.slice(0, 40)).slice(0, 24)}`;
  }

  chapters = chapters.map((chapter, index) => ({
    ...chapter,
    id: `c${index + 1}`,
    displayTitle: chapter.displayTitle || chapter.title,
  }));

  if (!chapters.length) {
    const error = new Error('PDF 文字无法形成章节。');
    error.code = 'PDF_STRUCTURE_FAILED';
    throw error;
  }

  const totalChars = flow.reduce((sum, line) => sum + line.text.length, 0);
  const importedAt = meta.importedAt || new Date().toISOString();
  const title = cleanText(meta.title || extraction.title || '未命名讲义').slice(0, 120);

  return {
    schema: 2,
    id: meta.id || `book_${Date.now().toString(36)}`,
    title,
    filename: meta.filename || '',
    pageCount: extraction.pageCount || pages.length,
    charCount: totalChars,
    importedAt,
    warnings: [],
    stats: {
      chapters: chapters.length,
      pages: extraction.pageCount || pages.length,
      chars: totalChars,
    },
    chapters,
    threads: [],
  };
}

module.exports = { buildBook };

'use strict';

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const { extractPdf, cleanText } = require('./pdf');
const { buildBook } = require('./segment');

const DEFAULT_SETTINGS = {
  ai: {
    baseUrl: 'https://api.deepseek.com',
    model: 'deepseek-chat',
    apiKey: '',
    temperature: 0.6,
  },
  prefs: {
    fontScale: 1,
    theme: 'warm',
    reduceMotion: false,
  },
};

const UNCATEGORIZED = 'uncategorized';
const DEFAULT_MEMOS = {
  schema: 1,
  categories: [{ id: UNCATEGORIZED, name: '未分类', builtin: true, createdAt: '' }],
  memos: [],
};

function sanitizeMessageAttachments(input) {
  if (!Array.isArray(input)) return [];
  const output = [];
  let total = 0;
  for (const attachment of input.slice(0, 6)) {
    if (!attachment || typeof attachment !== 'object') continue;
    const dataUrl = String(attachment.dataUrl || '');
    if (!/^data:image\/(?:png|jpeg|jpg);base64,[A-Za-z0-9+/=]+$/i.test(dataUrl)) continue;
    if (dataUrl.length > 4 * 1024 * 1024) continue;
    if (total + dataUrl.length > 8 * 1024 * 1024) break;
    total += dataUrl.length;
    output.push({
      dataUrl,
      page: Number(attachment.page) || 1,
      snippet: cleanText(attachment.snippet || '').slice(0, 3000),
      chapterId: String(attachment.chapterId || '').slice(0, 120),
      label: String(attachment.label || '').slice(0, 200),
    });
  }
  return output;
}

class Store {
  constructor(dataDir) {
    this.dataDir = dataDir;
    this.libraryDir = path.join(dataDir, 'library');
    this.incomingDir = path.join(this.libraryDir, '.incoming');
    this.settingsFile = path.join(dataDir, 'settings.json');
    this.memosFile = path.join(dataDir, 'memos.json');
    this.indexFile = path.join(this.libraryDir, 'index.json');
    this.locks = new Map();
  }

  async init() {
    await fsp.mkdir(this.libraryDir, { recursive: true });
    await fsp.mkdir(this.incomingDir, { recursive: true });
    const settings = await this.readSettings();
    if (!fs.existsSync(this.settingsFile)) await this.writeSettings(settings);
    if (!fs.existsSync(this.memosFile)) await this.writeMemos(DEFAULT_MEMOS);
    await this.rebuildIndexIfNeeded();
  }

  async readJson(file, fallback) {
    try {
      const raw = await fsp.readFile(file, 'utf8');
      return JSON.parse(raw.replace(/^\uFEFF/, ''));
    } catch (error) {
      if (error.code === 'ENOENT') return fallback;
      if (error instanceof SyntaxError) return fallback;
      throw error;
    }
  }

  async writeJsonAtomic(file, value) {
    const dir = path.dirname(file);
    await fsp.mkdir(dir, { recursive: true });
    const tmp = path.join(dir, `.tmp-${process.pid}-${crypto.randomBytes(4).toString('hex')}.json`);
    await fsp.writeFile(tmp, JSON.stringify(value, null, 2), 'utf8');
    await fsp.rename(tmp, file);
  }

  async withLock(key, task) {
    const previous = this.locks.get(key) || Promise.resolve();
    const next = previous.catch(() => {}).then(task);
    this.locks.set(key, next);
    next.finally(() => {
      if (this.locks.get(key) === next) this.locks.delete(key);
    }).catch(() => {});
    return next;
  }

  async listBooks() {
    const index = await this.readJson(this.indexFile, null);
    if (!Array.isArray(index)) return this.rebuildIndex();
    const valid = [];
    for (const entry of index) {
      if (!entry || !entry.id) continue;
      if (fs.existsSync(path.join(this.libraryDir, entry.id, 'book.json'))) valid.push(entry);
    }
    if (valid.length !== index.length) await this.writeJsonAtomic(this.indexFile, valid);
    return valid.sort((a, b) => String(b.updatedAt || b.importedAt).localeCompare(String(a.updatedAt || a.importedAt)));
  }

  async rebuildIndexIfNeeded() {
    if (!fs.existsSync(this.indexFile)) await this.rebuildIndex();
  }

  async rebuildIndex() {
    const entries = [];
    let names = [];
    try {
      names = await fsp.readdir(this.libraryDir);
    } catch {
      names = [];
    }
    for (const name of names) {
      if (name.startsWith('.')) continue;
      const file = path.join(this.libraryDir, name, 'book.json');
      const book = await this.readJson(file, null);
      if (book) entries.push(this.summaryOf(book));
    }
    await this.writeJsonAtomic(this.indexFile, entries);
    return entries.sort((a, b) => String(b.updatedAt || b.importedAt).localeCompare(String(a.updatedAt || a.importedAt)));
  }

  summaryOf(book) {
    return {
      id: book.id,
      title: book.title,
      filename: book.filename,
      pageCount: book.pageCount,
      importedAt: book.importedAt,
      updatedAt: book.updatedAt || book.importedAt,
      stats: book.stats,
      warnings: book.warnings || [],
      cover: book.cover || null,
    };
  }

  async updateIndexForBook(book) {
    const entries = await this.listBooks();
    const summary = this.summaryOf(book);
    const index = entries.filter((entry) => entry.id !== book.id);
    index.unshift(summary);
    await this.writeJsonAtomic(this.indexFile, index);
  }

  bookDir(id) {
    if (!/^book_[a-z0-9]+$/i.test(String(id || ''))) throw new Error('无效的讲义编号。');
    return path.join(this.libraryDir, id);
  }

  async getBook(id) {
    const book = await this.readJson(path.join(this.bookDir(id), 'book.json'), null);
    if (!book) throw new Error('找不到这本讲义，它可能已经被删除了。');
    if (!Array.isArray(book.threads)) book.threads = [];
    return book;
  }

  async saveBook(book) {
    book.updatedAt = new Date().toISOString();
    await this.writeJsonAtomic(path.join(this.bookDir(book.id), 'book.json'), book);
    await this.updateIndexForBook(book);
    return book;
  }

  async importPdf(filePath, options = {}, onProgress = () => {}) {
    if (!filePath || !fs.existsSync(filePath)) {
      const error = new Error('没有找到这个 PDF 文件。它可能被移动或删除了。');
      error.code = 'FILE_NOT_FOUND';
      throw error;
    }
    const stat = await fsp.stat(filePath);
    if (!stat.isFile()) throw new Error('请选择一个 PDF 文件。');
    if (!/\.pdf$/i.test(filePath)) throw new Error('目前只支持 PDF 讲义。');
    if (stat.size > 120 * 1024 * 1024) throw new Error('这份 PDF 超过 120 MB，暂时有点太大。可以先压缩一下，或拆分后再导入。');

    const id = `book_${Date.now().toString(36)}${crypto.randomBytes(3).toString('hex')}`;
    const incoming = path.join(this.incomingDir, id);
    await fsp.mkdir(incoming, { recursive: true });
    const tmpPdf = path.join(incoming, 'source.pdf');
    try {
      onProgress({ stage: 'copy', progress: 0.04, label: '导入中' });
      // fs.copyFile does not reliably read from Electron's asar archive. Reading
      // through fs.promises and writing the bytes works both inside asar and in
      // a normal development checkout.
      await fsp.writeFile(tmpPdf, await fsp.readFile(filePath));
      onProgress({ stage: 'extract', progress: 0.1, label: '解析 PDF' });
      const extraction = await extractPdf(tmpPdf, (stage, progress) => {
        onProgress({ stage: 'extract', progress: 0.1 + progress * 0.66, label: '解析 PDF' });
      });
      onProgress({ stage: 'structure', progress: 0.82, label: '划分章节' });
      const book = buildBook(extraction, {
        id,
        title: options.title || extraction.title,
        filename: path.basename(filePath),
        importedAt: new Date().toISOString(),
      });
      const finalDir = path.join(this.libraryDir, id);
      await fsp.mkdir(finalDir, { recursive: true });
      await fsp.copyFile(tmpPdf, path.join(finalDir, 'source.pdf'));
      book.sourceFile = 'source.pdf';
      book.hash = extraction.hash;
      book.metadata = extraction.metadata;
      book.threads = [];
      await this.writeJsonAtomic(path.join(finalDir, 'book.json'), book);
      await this.updateIndexForBook(book);
      onProgress({ stage: 'done', progress: 1, label: '已经整理好了' });
      return book;
    } finally {
      await fsp.rm(incoming, { recursive: true, force: true }).catch(() => {});
    }
  }

  async renameBook(id, title) {
    const nextTitle = cleanText(title).slice(0, 100);
    if (!nextTitle) throw new Error('标题不能为空。');
    return this.withLock(id, async () => {
      const book = await this.getBook(id);
      book.title = nextTitle;
      await this.saveBook(book);
      return this.summaryOf(book);
    });
  }

  async deleteBook(id) {
    const dir = this.bookDir(id);
    await this.withLock(id, async () => {
      await fsp.rm(dir, { recursive: true, force: true });
      const entries = await this.listBooks();
      await this.writeJsonAtomic(this.indexFile, entries.filter((entry) => entry.id !== id));
    });
    return { ok: true };
  }

  sourcePath(book) {
    return path.join(this.libraryDir, book.id, book.sourceFile || 'source.pdf');
  }

  async createThread(bookId, anchorInput) {
    return this.withLock(bookId, async () => {
      const book = await this.getBook(bookId);
      const anchor = this.sanitizeAnchor(book, anchorInput);
      const now = new Date().toISOString();
      const thread = {
        id: `t_${Date.now().toString(36)}${crypto.randomBytes(3).toString('hex')}`,
        anchor,
        title: '新的提问',
        createdAt: now,
        updatedAt: now,
        messages: [],
      };
      book.threads.push(thread);
      await this.saveBook(book);
      return thread;
    });
  }

  sanitizeAnchor(book, input) {
    const data = input || {};
    let chapter = (book.chapters || []).find((item) => item.id === data.chapterId) || null;
    const page = Number(data.page) || (chapter ? chapter.page : 1);
    if (!chapter) {
      chapter = [...(book.chapters || [])]
        .sort((a, b) => b.page - a.page)
        .find((item) => item.page <= page) || null;
    }
    let type = ['chapter', 'text', 'image', 'book'].includes(data.type) ? data.type : 'chapter';
    const snippet = cleanText(data.snippet || '').slice(0, 4000);
    if (type === 'text' && !snippet) type = 'chapter';
    let imageDataUrl = '';
    if (type === 'image') {
      const value = String(data.imageDataUrl || '');
      if (/^data:image\/(?:png|jpeg|jpg);base64,[A-Za-z0-9+/=]+$/i.test(value) && value.length <= 4 * 1024 * 1024) {
        imageDataUrl = value;
      } else {
        type = snippet ? 'text' : 'chapter';
      }
    }
    if (type === 'book' || !chapter) {
      return { type: 'book', page: 1, label: book.title, snippet };
    }
    return {
      type,
      chapterId: chapter.id,
      page: type === 'chapter' ? chapter.page : (Number(data.page) || chapter.page),
      label: chapter.displayTitle,
      snippet,
      imageDataUrl,
    };
  }

  async appendMessage(bookId, threadId, message) {
    return this.withLock(bookId, async () => {
      const book = await this.getBook(bookId);
      const thread = (book.threads || []).find((item) => item.id === threadId);
      if (!thread) throw new Error('对话不存在。');
      const attachments = message.role === 'user' ? sanitizeMessageAttachments(message.attachments) : [];
      const entry = {
        id: `m_${Date.now().toString(36)}${crypto.randomBytes(2).toString('hex')}`,
        role: message.role === 'assistant' ? 'assistant' : 'user',
        content: String(message.content || ''),
        createdAt: new Date().toISOString(),
        source: message.source || 'ai',
      };
      if (attachments.length) entry.attachments = attachments;
      thread.messages.push(entry);
      thread.updatedAt = entry.createdAt;
      if (entry.role === 'user' && (thread.title === '新的提问' || !thread.title)) {
        thread.title = cleanText(entry.content).slice(0, 36) || '新的提问';
      }
      await this.saveBook(book);
      return { thread, message: entry };
    });
  }

  async deleteThread(bookId, threadId) {
    return this.withLock(bookId, async () => {
      const book = await this.getBook(bookId);
      const before = book.threads.length;
      book.threads = book.threads.filter((thread) => thread.id !== threadId);
      if (book.threads.length === before) throw new Error('这段对话已经不在了。');
      await this.saveBook(book);
      return { ok: true };
    });
  }

  async getThread(bookId, threadId) {
    const book = await this.getBook(bookId);
    const thread = (book.threads || []).find((item) => item.id === threadId);
    if (!thread) throw new Error('这段对话找不到了。');
    return { book, thread };
  }

  async readSettings() {
    const raw = await this.readJson(this.settingsFile, {});
    return {
      ai: {
        ...DEFAULT_SETTINGS.ai,
        ...(raw && raw.ai ? raw.ai : {}),
      },
      prefs: {
        ...DEFAULT_SETTINGS.prefs,
        ...(raw && raw.prefs ? raw.prefs : {}),
      },
    };
  }

  async writeSettings(settings) {
    await this.writeJsonAtomic(this.settingsFile, settings);
  }

  async readMemos() {
    const data = await this.readJson(this.memosFile, null);
    if (!data || !Array.isArray(data.categories) || !Array.isArray(data.memos)) {
      return { ...DEFAULT_MEMOS, categories: [{ ...DEFAULT_MEMOS.categories[0], createdAt: new Date().toISOString() }] };
    }
    const categories = data.categories
      .filter((category) => category && category.id && category.name)
      .map((category) => ({
        id: String(category.id),
        name: String(category.name).slice(0, 24),
        builtin: category.id === UNCATEGORIZED,
        createdAt: category.createdAt || '',
      }));
    if (!categories.some((category) => category.id === UNCATEGORIZED)) {
      categories.unshift({ ...DEFAULT_MEMOS.categories[0], createdAt: new Date().toISOString() });
    }
    const memos = data.memos
      .filter((memo) => memo && memo.id && memo.title)
      .map((memo) => ({
        id: String(memo.id),
        title: String(memo.title).slice(0, 120),
        content: String(memo.content || '').slice(0, 50000),
        categoryId: categories.some((category) => category.id === memo.categoryId) ? memo.categoryId : UNCATEGORIZED,
        bookId: String(memo.bookId || ''),
        bookTitle: String(memo.bookTitle || '').slice(0, 160),
        chapterId: String(memo.chapterId || ''),
        chapterTitle: String(memo.chapterTitle || '').slice(0, 200),
        page: Number(memo.page) || 1,
        threadId: String(memo.threadId || ''),
        createdAt: memo.createdAt || new Date().toISOString(),
        updatedAt: memo.updatedAt || memo.createdAt || new Date().toISOString(),
      }))
      .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
    return { schema: 1, categories, memos };
  }

  async writeMemos(data) {
    await this.writeJsonAtomic(this.memosFile, data);
  }

  async listMemos() {
    return this.readMemos();
  }

  async saveMemo(input = {}) {
    const title = cleanText(input.title || '').slice(0, 120);
    const content = String(input.content || '').trim().slice(0, 50000);
    if (!title) throw new Error('备忘录标题不能为空。');
    if (!content) throw new Error('备忘录内容不能为空。');
    return this.withLock('__memos__', async () => {
      const data = await this.readMemos();
      const categoryId = data.categories.some((category) => category.id === input.categoryId)
        ? input.categoryId
        : UNCATEGORIZED;
      const now = new Date().toISOString();
      const id = String(input.id || '');
      const existing = id ? data.memos.find((memo) => memo.id === id) : null;
      const memo = {
        id: existing ? existing.id : `memo_${Date.now().toString(36)}${crypto.randomBytes(3).toString('hex')}`,
        title,
        content,
        categoryId,
        bookId: String(input.bookId || (existing?.bookId || '')),
        bookTitle: String(input.bookTitle || (existing?.bookTitle || '')).slice(0, 160),
        chapterId: String(input.chapterId || (existing?.chapterId || '')),
        chapterTitle: String(input.chapterTitle || (existing?.chapterTitle || '')).slice(0, 200),
        page: Number(input.page) || existing?.page || 1,
        threadId: String(input.threadId || (existing?.threadId || '')),
        createdAt: existing?.createdAt || now,
        updatedAt: now,
      };
      if (existing) Object.assign(existing, memo);
      else data.memos.unshift(memo);
      data.memos.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
      await this.writeMemos(data);
      return { memo, data };
    });
  }

  async deleteMemo(memoId) {
    return this.withLock('__memos__', async () => {
      const data = await this.readMemos();
      data.memos = data.memos.filter((memo) => memo.id !== String(memoId));
      await this.writeMemos(data);
      return data;
    });
  }

  async saveMemoCategory(input = {}) {
    const name = cleanText(input.name || '').slice(0, 24);
    if (!name) throw new Error('分类名称不能为空。');
    return this.withLock('__memos__', async () => {
      const data = await this.readMemos();
      const id = String(input.id || '');
      const category = id ? data.categories.find((item) => item.id === id) : null;
      if (category?.builtin) throw new Error('未分类不能重命名。');
      if (data.categories.some((item) => item.id !== id && item.name.toLowerCase() === name.toLowerCase())) {
        throw new Error('已经有同名分类。');
      }
      if (category) category.name = name;
      else {
        data.categories.push({
          id: `cat_${Date.now().toString(36)}${crypto.randomBytes(2).toString('hex')}`,
          name,
          builtin: false,
          createdAt: new Date().toISOString(),
        });
      }
      await this.writeMemos(data);
      return data;
    });
  }

  async deleteMemoCategory(categoryId) {
    const id = String(categoryId || '');
    if (id === UNCATEGORIZED) throw new Error('未分类不能删除。');
    return this.withLock('__memos__', async () => {
      const data = await this.readMemos();
      data.categories = data.categories.filter((category) => category.id !== id);
      for (const memo of data.memos) {
        if (memo.categoryId === id) memo.categoryId = UNCATEGORIZED;
      }
      await this.writeMemos(data);
      return data;
    });
  }

  async saveSettings(patch = {}) {
    const current = await this.readSettings();
    const ai = patch.ai || {};
    if (typeof ai.baseUrl === 'string') current.ai.baseUrl = ai.baseUrl.trim().slice(0, 500) || DEFAULT_SETTINGS.ai.baseUrl;
    if (typeof ai.model === 'string') current.ai.model = ai.model.trim().slice(0, 120) || DEFAULT_SETTINGS.ai.model;
    if (typeof ai.temperature === 'number' && Number.isFinite(ai.temperature)) {
      current.ai.temperature = Math.min(1.2, Math.max(0, ai.temperature));
    }
    if (patch.clearKey) current.ai.apiKey = '';
    else if (typeof ai.apiKey === 'string' && ai.apiKey.trim()) current.ai.apiKey = ai.apiKey.trim().slice(0, 500);
    const prefs = patch.prefs || {};
    if (typeof prefs.fontScale === 'number') current.prefs.fontScale = Math.min(1.25, Math.max(0.88, prefs.fontScale));
    if (prefs.theme === 'warm' || prefs.theme === 'night') current.prefs.theme = prefs.theme;
    if (typeof prefs.reduceMotion === 'boolean') current.prefs.reduceMotion = prefs.reduceMotion;
    await this.writeSettings(current);
    return current;
  }
}

module.exports = { Store, DEFAULT_SETTINGS };

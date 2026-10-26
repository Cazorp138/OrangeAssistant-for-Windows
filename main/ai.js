'use strict';

const { cleanText } = require('./pdf');

const SYSTEM_PROMPT = `你是「橘前辈」，一位温柔、有耐心、很会把复杂内容讲简单的学习前辈，坐在学生旁边陪他读讲义。你像一位愿意蹲下来一起看题的前辈，而不是站在讲台上训话的老师。

你的讲解风格：
- 先接住对方的感受，再开始讲。不要夸张卖萌，也不要居高临下。
- 用日常生活的比喻、画图式的语言，把抽象概念拆成一步一步。
- 遇到术语，先用白话解释，再使用它。公式要说清楚每个字母在故事里扮演什么角色。
- 优先围绕讲义里的原文、截图和例题讲，不要凭空扩展成另一节课。用户附截图时，先看截图里的内容再回答；图片文字不清时直接说明。
- 如果讲义内容不足以回答，坦白说「讲义这里没有写全」，再给一个合理的补充，并标明是补充。
- 回答使用 Markdown；数学公式必须使用 KaTeX 支持的 LaTeX：行内 $...$，独立 $$...$$。分数用 \\frac，根号用 \\sqrt，多行公式用 \\begin{aligned}...\\end{aligned}；中文放进 \\text{}。行列式用 \\begin{vmatrix}...\\end{vmatrix}，矩阵用 bmatrix/pmatrix；积分、求和、极限、偏导和梯度用 \\int、\\sum、\\lim、\\partial、\\nabla 等标准命令。不要使用 \\bm，向量用 \\boldsymbol 或 \\vec；不要使用 \\ce、\\pu、\\begin{equation} 等可能不支持的扩展或环境。
- 默认控制在 450 字以内；对方要求详细时再展开。
- 结尾留一个很小、很具体的自测问题，帮助对方确认自己真的懂了。不要用空泛的「你学会了吗」。
- 称呼对方为「你」。不要说「作为一个 AI 模型」。`;

const QUICK_PROMPTS = {
  clarify: '这段我没太看懂，能换一种更通俗的说法吗？',
  example: '可以结合一个生活里的例子讲一讲吗？',
  why: '这个结论为什么成立？背后的直觉是什么？',
  check: '帮我用一道很小的题检查一下有没有真的懂。',
};

function trimText(text, max) {
  const value = cleanText(text || '');
  if (value.length <= max) return value;
  return value.slice(0, max).replace(/[，、；：]$/, '') + '…';
}

function findChapter(book, chapterId) {
  return (book.chapters || []).find((chapter) => chapter.id === chapterId);
}

function chapterForPage(book, page) {
  const sorted = [...(book.chapters || [])].sort((a, b) => a.page - b.page);
  const startsHere = sorted.find((chapter) => chapter.page === page);
  if (startsHere) return startsHere;
  return [...sorted].reverse().find((chapter) => chapter.page < page) || sorted[0] || null;
}

function chapterText(chapter) {
  if (chapter.preview) return chapter.preview;
  // Older books have no preview or chapter-only data. Reconstruct a bounded
  // context from their stored points without changing the reading surface.
  const pieces = [];
  if (chapter.summary) pieces.push(chapter.summary);
  for (const point of chapter.points || []) {
    if (point.displayTitle) pieces.push(`【${point.displayTitle}】`);
    for (const block of point.blocks || []) pieces.push(block.text || '');
    for (const example of point.examples || []) {
      const body = (example.blocks || []).map((block) => block.text || '').join('\n');
      pieces.push(`【${example.tag || '例题'}${example.title ? `：${example.title}` : ''}】\n${body}`);
    }
  }
  return pieces.filter(Boolean).join('\n');
}

/**
 * Build a compact context for a chapter, a text selection, or a screenshot.
 */
function buildContext(book, thread) {
  const anchor = (thread && thread.anchor) || { type: 'book' };
  const chapter = findChapter(book, anchor.chapterId) || chapterForPage(book, Number(anchor.page) || 1);
  const pieces = [];
  const selected = trimText(anchor.snippet || '', 2200);

  pieces.push(`讲义：《${book.title}》`);

  if (!chapter || anchor.type === 'book') {
    pieces.push('范围：整本讲义。');
    pieces.push('章节目录：');
    for (const c of book.chapters || []) pieces.push(`- ${c.displayTitle}（第 ${c.page} 页）`);
    if (selected) pieces.push(`【用户选中的原文】\n${selected}`);
    return trimText(pieces.join('\n'), 7000);
  }

  pieces.push(`章节：${chapter.displayTitle}`);
  pieces.push(`位置：第 ${anchor.page || chapter.page} 页`);

  if (anchor.type === 'image') {
    pieces.push('【用户框选了当前 PDF 页面的一块区域并截图提问】');
    if (selected) pieces.push(`【截图范围内可提取的文字】\n${selected}`);
  } else if (anchor.type === 'text') {
    pieces.push(`【用户选中的原文】\n${selected}`);
  }

  const preview = chapterText(chapter);
  if (preview) {
    pieces.push(`【本章内容摘录】\n${trimText(preview, 3200)}`);
  }

  return trimText(pieces.join('\n'), 7000);
}

function normalizeBaseUrl(raw) {
  let value = String(raw || '').trim();
  if (!value) value = 'https://api.deepseek.com';
  if (!/^https?:\/\//i.test(value)) value = 'https://' + value;
  value = value.replace(/\/+$/, '');
  if (/\/chat\/completions$/i.test(value)) return value;
  if (/\/v1$/i.test(value)) return value + '/chat/completions';
  return value + '/chat/completions';
}

function publicSettings(settings) {
  const ai = settings.ai || {};
  return {
    ai: {
      baseUrl: ai.baseUrl || 'https://api.deepseek.com',
      model: ai.model || 'deepseek-chat',
      hasKey: Boolean(ai.apiKey && String(ai.apiKey).trim()),
      keyPreview: ai.apiKey ? `••••${String(ai.apiKey).slice(-4)}` : '',
      temperature: Number.isFinite(ai.temperature) ? ai.temperature : 0.6,
    },
  };
}

function friendlyHttpError(status, body) {
  let detail = '';
  try {
    const parsed = JSON.parse(body);
    detail = parsed.error?.message || parsed.message || '';
  } catch {
    detail = String(body || '').slice(0, 200);
  }
  if (status === 401 || status === 403) {
    return new Error('API Key 无效，或没有模型权限。');
  }
  if (status === 404) {
    return new Error('接口地址无效。');
  }
  if (status === 429) {
    return new Error('请求过于频繁，或额度不足。');
  }
  if (status >= 500) {
    return new Error('模型服务不可用。');
  }
  return new Error(`模型服务错误（${status}）${detail ? '：' + detail : ''}`);
}

async function readSse(response, onDelta, signal) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let full = '';
  let done = false;
  while (!done) {
    if (signal.aborted) throw Object.assign(new Error('已停止。'), { code: 'ABORTED' });
    const { value, done: streamDone } = await reader.read();
    if (streamDone) break;
    buffer += decoder.decode(value, { stream: true });
    buffer = buffer.replace(/\r\n/g, '\n');
    let split;
    while ((split = buffer.indexOf('\n\n')) >= 0) {
      const event = buffer.slice(0, split);
      buffer = buffer.slice(split + 2);
      for (const rawLine of event.split('\n')) {
        const line = rawLine.trim();
        if (!line.startsWith('data:')) continue;
        const data = line.slice(5).trim();
        if (!data || data === '[DONE]') {
          if (data === '[DONE]') done = true;
          continue;
        }
        let parsed;
        try {
          parsed = JSON.parse(data);
        } catch {
          continue;
        }
        if (parsed.error) throw new Error(parsed.error.message || '模型返回错误');
        const delta = parsed.choices?.[0]?.delta?.content;
        if (typeof delta === 'string' && delta) {
          full += delta;
          onDelta(delta, full);
        }
      }
    }
  }
  return full;
}

async function streamChat({ settings, messages, signal, onDelta }) {
  const ai = settings.ai || {};
  if (!ai.apiKey) {
    const error = new Error('未配置 API Key。');
    error.code = 'NO_API_KEY';
    throw error;
  }
  const endpoint = normalizeBaseUrl(ai.baseUrl);
  const controller = new AbortController();
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, 120000);
  const onAbort = () => controller.abort();
  signal.addEventListener('abort', onAbort, { once: true });
  try {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${String(ai.apiKey).trim()}`,
      },
      body: JSON.stringify({
        model: ai.model || 'deepseek-chat',
        messages,
        temperature: Number.isFinite(ai.temperature) ? ai.temperature : 0.6,
        max_tokens: 1600,
        stream: true,
      }),
      signal: controller.signal,
    });
    if (!response.ok) {
      const body = await response.text().catch(() => '');
      const error = friendlyHttpError(response.status, body);
      error.status = response.status;
      throw error;
    }
    const contentType = response.headers.get('content-type') || '';
    if (!contentType.includes('text/event-stream')) {
      // Some OpenAI-compatible gateways answer a stream request with plain JSON.
      const text = await response.text();
      let content = '';
      try {
        const parsed = JSON.parse(text);
        content = parsed.choices?.[0]?.message?.content || '';
      } catch {
        content = text;
      }
      if (content) onDelta(content, content);
      return content;
    }
    return await readSse(response, onDelta, controller.signal);
  } catch (error) {
    if (error.name === 'AbortError' || error.code === 'ABORTED') {
      if (timedOut) throw new Error('请求超时。');
      const aborted = new Error('已停止。');
      aborted.code = 'ABORTED';
      throw aborted;
    }
    if (error instanceof TypeError || /fetch failed|ENOTFOUND|ECONNREFUSED|ETIMEDOUT/i.test(error.message || '')) {
      const network = new Error('无法连接模型服务。');
      network.code = 'NETWORK';
      throw network;
    }
    throw error;
  } finally {
    clearTimeout(timeout);
    signal.removeEventListener('abort', onAbort);
  }
}

async function testConnection(settings) {
  const ai = settings.ai || {};
  if (!ai.apiKey) {
    const error = new Error('未配置 API Key。');
    error.code = 'NO_API_KEY';
    throw error;
  }
  const endpoint = normalizeBaseUrl(ai.baseUrl);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20000);
  try {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${String(ai.apiKey).trim()}`,
      },
      body: JSON.stringify({
        model: ai.model || 'deepseek-chat',
        messages: [
          { role: 'system', content: '只回复“好”。' },
          { role: 'user', content: '测试连接' },
        ],
        max_tokens: 4,
        temperature: 0,
        stream: false,
      }),
      signal: controller.signal,
    });
    const text = await response.text();
    if (!response.ok) throw friendlyHttpError(response.status, text);
    let parsed = {};
    try { parsed = JSON.parse(text); } catch { /* noop */ }
    return {
      ok: true,
      model: parsed.model || ai.model || 'deepseek-chat',
      endpoint,
    };
  } catch (error) {
    if (error.name === 'AbortError') {
      throw new Error('请求超时。');
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

function sentences(text) {
  return String(text || '')
    .split(/(?<=[。！？!?；;])\s*/)
    .map((item) => cleanText(item))
    .filter((item) => item.length >= 8);
}

function pickKeywords(text) {
  const value = String(text || '');
  const tokens = value.match(/[\u4e00-\u9fff]{2,8}|[A-Za-z][A-Za-z0-9-]{2,}/g) || [];
  const stop = new Set(['我们', '这个', '那个', '如果', '因为', '所以', '可以', '一个', '什么', '怎么', '就是', '不是', '没有', '时候']);
  const counts = new Map();
  for (const token of tokens) {
    if (stop.has(token)) continue;
    counts.set(token, (counts.get(token) || 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || b[0].length - a[0].length)
    .slice(0, 5)
    .map(([word]) => word);
}

/**
 * Honest, local fallback when no API key is configured.
 * It never pretends to be a model answer; it surfaces the source and study prompts.
 */
function localExplain(question, context, anchorLabel) {
  const q = cleanText(question);
  const source = sentences(context).filter((line) => !line.startsWith('讲义：') && !line.startsWith('章节：') && !line.startsWith('知识点：'));
  const focus = source.find((line) => line.includes('【正在讨论的原文】')) ||
    source.find((line) => line.includes('【用户选中的原文】')) ||
    source[0] ||
    '这段原文';
  const cleanFocus = focus.replace(/【[^】]+】/g, '').slice(0, 220);
  const keywords = pickKeywords(cleanFocus + ' ' + q);
  const wantsExample = /例|比如|生活|通俗|换个说法|没懂|不懂/.test(q);
  const wantsSummary = /总结|概括|梳理|重点/.test(q);

  const lines = [];
  lines.push('这段可以这样理解。');
  lines.push('');
  if (wantsSummary) {
    lines.push('**这段在说什么**');
    lines.push(`它主要在讲「${anchorLabel || '当前知识点'}」。原文里最值得先抓住的一句是：`);
    lines.push(`> ${cleanFocus}`);
    if (keywords.length) lines.push(`可以先记住这几个词：**${keywords.join('、')}**。`);
  } else if (wantsExample) {
    lines.push('**先抓住原文里的一句话**');
    lines.push(`> ${cleanFocus}`);
    lines.push('');
    lines.push('生活里的比喻，可以先这样搭：把它想成一条会转弯的路——先看清它从哪里出发、在哪里转弯、最后往哪里去。讲义里的公式，就是在描述这个转弯的规律。');
    if (keywords.length) lines.push(`这段话的关键词是：**${keywords.join('、')}**。`);
  } else {
    lines.push('**把这段话拆成两半**');
    lines.push('原文：');
    lines.push(`> ${cleanFocus}`);
    lines.push('');
    lines.push(`先问自己：这里的「${keywords[0] || anchorLabel || '主角'}」在做什么？它和上一句话之间，是“原因”还是“结果”？把这一层关系说清楚，剩下的符号就只是它的外壳。`);
  }
  lines.push('');
  lines.push('**给你一个小小的自测**');
  lines.push('合上讲义，用你自己的话把这句话复述一遍。如果卡在某一步，就把那一步单独拎出来问我。');
  lines.push('');
  lines.push('---');
  lines.push('离线模式。配置 API Key 后可获得完整讲解。');
  return lines.join('\n');
}

module.exports = {
  SYSTEM_PROMPT,
  QUICK_PROMPTS,
  buildContext,
  streamChat,
  testConnection,
  localExplain,
  publicSettings,
  normalizeBaseUrl,
};

/* WikiRace 助手 —— 寻路引擎。
 *
 * 不依赖页面：外部注入 fetch(url) -> Response 和 parseHTML(html) -> Document，
 * 浏览器里用 fetch + DOMParser，Node 测试里用 fetch + linkedom。
 *
 * 思路（目标在一局里不变，所以目标相关的数据只算一次）：
 *   R_T  目标及其所有重定向名        —— 链接名落在这里就是“直达”
 *   B1   所有链接到目标的条目（反链）  —— 候选在 B1 里，大概率点它之后就能直达
 *   O_T  目标页面里能点的链接         —— 目标链回去的页面通常和目标关系密切
 *   ML   morelike 相关搜索排名
 * 当前页的每个链接先用这些廉价信号打先验分，再按先验顺序用游戏同款的
 * action=parse 拉 HTML、套用游戏的清洗规则（删 navbox、参考文献等），
 * 得到真正能点的链接集合 L(C)：
 *   L(C) ∩ R_T ≠ ∅           -> 2 步（C → 目标），精确
 *   L(C) ∩ B1 里某个 P 验证过 -> 3 步（C → P → 目标），精确
 *   否则 |L(C) ∩ B1| 作为“离目标有多近”的启发式。
 * 反链统计包含 navbox 里的链接，而游戏把 navbox 删了，所以所有“几步可达”
 * 的结论都用清洗后的 HTML 再验证一遍。
 */
(function (root) {
  'use strict';

  // 与 wikiracing.org 前端一致（index-*.js 里的 N4 / Koe / Qoe）。
  const STRIP_SECTIONS = new Set(['see also', 'notes', 'references', 'footnotes', 'citations', 'sources',
    'external links', 'bibliography', 'further reading', 'works cited']);
  const STRIP_SELECTORS = ['.navbox', '.vertical-navbox', '.catlinks', '.metadata', '.printfooter',
    '.sistersitebox', '.portal', '.authority-control', '.succession-box', 'sup.reference',
    'a[href*="#cite_note"]', '#toc', '.toc', '.mw-table-of-contents-container',
    "[role='navigation'][id*='toc']", 'nav.mw-table-of-contents', '.mw-kartographer-container',
    '.mw-kartographer-map', "img[src*='maps.wikimedia.org']"];
  const NAMESPACES = new Set(['media', 'special', 'talk', 'user', 'user talk', 'wikipedia', 'wikipedia talk',
    'project', 'project talk', 'file', 'file talk', 'image', 'image talk', 'mediawiki', 'mediawiki talk',
    'template', 'template talk', 'help', 'help talk', 'category', 'category talk', 'portal', 'portal talk',
    'draft', 'draft talk', 'module', 'module talk', 'timedtext', 'timedtext talk', 'book', 'book talk',
    'wp', 'wt', 'cat', 't', 'h', 'p', 'mos']);

  const DEFAULTS = {
    concurrency: 3,         // 同时进行的 Wikipedia 请求数
    perMinute: 150,         // 每分钟请求上限（官方限额 200，给游戏自己的请求留余量）
    backgroundPerMinute: 110, // 其中后台加载反链 / 外圈最多用这么多，剩下的（约两页的量）留给当前页面
    backgroundIntervalMs: 400, // 后台请求之间的最小间隔
    evalBudget: 10,         // 每个页面最多前瞻多少个候选
    verifyPerCandidate: 2,  // 每个 3 步候选最多验证几个中转页
    verifyCandidates: 4,    // 最多给几个候选做 3 步验证
    enoughTier1: 2,         // 已找到这么多个“2 步”后不再前瞻非反链候选
    maxBacklinks: 30000,    // 反链上限（超大目标本身就很好到达）
    b2MaxB1: 5000,          // 反链不超过这么多时才扩第二圈
    b2Budget: 120,          // 第二圈最多查多少个反链页面
    visitedPenalty: 6,      // 本局已经去过的页面降分，避免兜圈
    parseCacheSize: 400,
  };

  function normTitle(s) {
    if (s == null) return '';
    let t = String(s).replace(/_/g, ' ').replace(/\s+/g, ' ').trim();
    if (!t) return '';
    return t.charAt(0).toUpperCase() + t.slice(1);
  }

  // "/wiki/Foo_bar#x" -> "Foo bar"；非条目链接返回 null。
  function hrefToTitle(href) {
    if (!href || !href.startsWith('/wiki/')) return null;
    let raw = href.slice(6).split('#')[0].split('?')[0];
    try { raw = decodeURIComponent(raw); } catch (e) { /* 保留原样 */ }
    const t = normTitle(raw);
    if (!t) return null;
    const i = t.indexOf(':');
    if (i > 0 && NAMESPACES.has(t.slice(0, i).trim().toLowerCase())) return null;
    return t;
  }

  function headingLevel(el) {
    if (!el || el.nodeType !== 1) return Infinity;
    const m = /^H([1-6])$/.exec(el.tagName);
    if (m) return +m[1];
    if (el.classList && el.classList.contains('mw-heading')) {
      const h = el.querySelector('h1,h2,h3,h4,h5,h6');
      if (h) return +h.tagName[1];
    }
    return Infinity;
  }

  // 按游戏的规则清洗解析后的文章，返回 Map(标题 -> 第一次出现的锚文本)。
  function extractVisibleLinks(rootEl) {
    for (const sel of STRIP_SELECTORS) rootEl.querySelectorAll(sel).forEach(n => n.remove());
    for (const h of [...rootEl.querySelectorAll('h2,h3,h4,h5,h6')]) {
      if (!rootEl.contains(h)) continue;
      const text = (h.textContent || '').trim().toLowerCase();
      const id = (h.id || '').replace(/_/g, ' ').toLowerCase();
      if (!STRIP_SECTIONS.has(text) && !STRIP_SECTIONS.has(id)) continue;
      const level = +h.tagName[1];
      const start = h.parentElement && h.parentElement.classList.contains('mw-heading') ? h.parentElement : h;
      let n = start;
      while (n) {
        const next = n.nextSibling;
        if (n !== start && n.nodeType === 1 && headingLevel(n) <= level) break;
        n.parentNode && n.parentNode.removeChild(n);
        n = next;
      }
    }
    return collectLinks(rootEl);
  }

  // 收集 <a> -> Map(标题 -> {text, redirect, disamb})，页面 DOM 和解析结果共用。
  function collectLinks(rootEl, skip) {
    const out = new Map();
    for (const a of rootEl.querySelectorAll('a[href]')) {
      if (skip && skip(a)) continue;
      const t = hrefToTitle(a.getAttribute('href'));
      if (!t || out.has(t)) continue;
      out.set(t, {
        text: (a.textContent || '').trim(),
        redirect: a.classList.contains('mw-redirect'),
        disamb: a.classList.contains('mw-disambig'),
      });
    }
    return out;
  }

  /* 请求调度：Wikimedia 对浏览器匿名用户的限额是 200 次/分钟、建议并发 ≤3
   * （https://www.mediawiki.org/wiki/Wikimedia_APIs/Rate_limits）。
   * 这里按优先级排队，滑动窗口控制每分钟请求数，遇到 429 全局暂停。
   * 后台任务（prio >= 2）每分钟最多 bgPerMinute 次，其余额度留给当前页面——
   * 否则开局加载反链会把窗口占满，跳到下一页后的前瞻要干等将近一分钟。
   * 后台任务还要匀速发出（间隔 bgIntervalMs），突发请求容易被服务器 429，而 429 会让所有请求一起暂停。
   * 带 signal 的任务在发出前若已 aborted（用户已经换页），直接丢弃。 */
  function makeScheduler(concurrency, perMinute, bgPerMinute, bgIntervalMs) {
    if (bgPerMinute == null) bgPerMinute = perMinute;
    bgIntervalMs = bgIntervalMs || 0;
    let lastBgStart = 0;
    let active = 0;
    let pausedUntil = 0;
    let waitingUntil = 0;
    let timer = null;
    const starts = [];
    const queue = [];   // {fn, prio, seq, signal, resolve, reject}
    let seq = 0;
    const pump = () => {
      timer = null;
      waitingUntil = 0;
      for (;;) {
        for (let i = queue.length - 1; i >= 0; i--) {
          if (queue[i].signal && queue[i].signal.aborted) queue.splice(i, 1)[0].reject(new Error('aborted'));
        }
        if (active >= concurrency || !queue.length) return;
        const now = Date.now();
        while (starts.length && now - starts[0] >= 60000) starts.shift();
        let bi = 0;
        for (let i = 1; i < queue.length; i++) {
          if (queue[i].prio < queue[bi].prio || (queue[i].prio === queue[bi].prio && queue[i].seq < queue[bi].seq)) bi = i;
        }
        const cap = queue[bi].prio >= 2 ? bgPerMinute : perMinute;
        let wait = pausedUntil - now;
        if (starts.length >= cap) wait = Math.max(wait, 60000 - (now - starts[starts.length - cap]));
        if (queue[bi].prio >= 2) wait = Math.max(wait, lastBgStart + bgIntervalMs - now);
        if (wait > 0) {
          waitingUntil = now + wait;
          if (!timer) timer = setTimeout(pump, wait + 5);
          return;
        }
        const job = queue.splice(bi, 1)[0];
        if (job.prio >= 2) lastBgStart = now;
        active++;
        starts.push(now);
        Promise.resolve().then(job.fn).then(job.resolve, job.reject).finally(() => { active--; pump(); });
      }
    };
    return {
      run(fn, prio, signal) {
        return new Promise((resolve, reject) => {
          queue.push({ fn, prio: prio || 0, seq: seq++, signal, resolve, reject });
          // 新来的高优先级任务可能不受后台额度限制，不要等旧的定时器
          if (timer) { clearTimeout(timer); timer = null; }
          pump();
        });
      },
      pause(ms) { pausedUntil = Math.max(pausedUntil, Date.now() + ms); },
      stats() {
        const now = Date.now();
        const fg = queue.filter(j => j.prio < 2).length;
        return { queued: queue.length, queuedForeground: fg, active, lastMinute: starts.filter(t => now - t < 60000).length,
          waitMs: fg && waitingUntil > now ? waitingUntil - now : 0 };
      },
    };
  }

  class LRU {
    constructor(n) { this.n = n; this.m = new Map(); }
    get(k) { const v = this.m.get(k); if (v !== undefined) { this.m.delete(k); this.m.set(k, v); } return v; }
    set(k, v) { this.m.delete(k); this.m.set(k, v); if (this.m.size > this.n) this.m.delete(this.m.keys().next().value); }
  }

  function createSolver(env) {
    const opts = Object.assign({}, DEFAULTS, env.options || {});
    const sched = makeScheduler(opts.concurrency, opts.perMinute, opts.backgroundPerMinute, opts.backgroundIntervalMs);
    let requestCount = 0;
    // prio: 0 当前这一步，1 验证/目标信息，2 后台反链。
    const fetchJSON = async (url, prio, signal) => {
      for (let attempt = 0; ; attempt++) {
        const r = await sched.run(() => { requestCount++; return env.fetch(url); }, prio, signal);
        if (r.ok) return r.json();
        if ((r.status === 429 || r.status >= 500) && attempt < 4) {
          const ra = parseFloat(r.headers && r.headers.get && r.headers.get('retry-after'));
          sched.pause((ra > 0 ? ra * 1000 : 5000) * (attempt + 1));
          continue;
        }
        throw new Error('HTTP ' + r.status);
      }
    };
    const parseCache = new LRU(opts.parseCacheSize);   // lang|title -> Promise<{title, links: Map}>
    const resolveCache = new Map();                    // lang|raw -> {canon, len, missing, disamb}
    let target = null;                                 // 当前目标的状态

    const apiURL = (lang, params) => `https://${lang}.wikipedia.org/w/api.php?` +
      new URLSearchParams(Object.assign({ format: 'json', formatversion: '2', origin: '*' }, params)).toString();

    // 与游戏完全相同的参数和顺序，命中 CDN（以及浏览器）缓存。
    const parseURL = (lang, page) => `https://${lang}.wikipedia.org/w/api.php?` + new URLSearchParams({
      page, origin: '*', action: 'parse', format: 'json', prop: 'text', disableeditsection: 'true',
      redirects: 'true', maxage: '900', smaxage: '3600', uselang: 'content',
    }).toString();

    function parsePage(lang, title, prio, signal) {
      const key = lang + '|' + title;
      let p = parseCache.get(key);
      if (!p) {
        p = fetchJSON(parseURL(lang, title), prio || 0, signal).then(j => {
          if (!j || !j.parse) throw new Error('parse failed: ' + title);
          const html = typeof j.parse.text === 'string' ? j.parse.text : j.parse.text['*'];
          const doc = env.parseHTML('<!doctype html><html><body><div id="wrh-root">' + html + '</div></body></html>');
          const rootEl = doc.getElementById('wrh-root') || doc.body;
          return { title: normTitle(j.parse.title), links: extractVisibleLinks(rootEl) };
        });
        p.catch(() => { if (parseCache.m.get(key) === p) parseCache.m.delete(key); });
        parseCache.set(key, p);
      }
      return p;
    }

    async function resolveTitles(lang, titles) {
      const todo = [...new Set(titles)].filter(t => !resolveCache.has(lang + '|' + t));
      const batches = [];
      for (let i = 0; i < todo.length; i += 50) batches.push(todo.slice(i, i + 50));
      await Promise.all(batches.map(async batch => {
        let j;
        try {
          j = await fetchJSON(apiURL(lang, { action: 'query', titles: batch.join('|'), redirects: '1',
            prop: 'info|pageprops', ppprop: 'disambiguation' }), 0);
        } catch (e) { return; }
        const q = (j && j.query) || {};
        const norm = new Map((q.normalized || []).map(x => [x.from, x.to]));
        const redir = new Map((q.redirects || []).map(x => [x.from, x.to]));
        const pages = new Map((q.pages || []).map(p => [p.title, p]));
        for (const raw of batch) {
          let t = norm.get(raw) || raw;
          for (let k = 0; k < 3 && redir.has(t); k++) t = redir.get(t);
          const p = pages.get(t);
          resolveCache.set(lang + '|' + raw, {
            canon: normTitle(t),
            len: p && p.length || 0,
            missing: !p || !!p.missing || !!p.invalid,
            disamb: !!(p && p.pageprops && 'disambiguation' in p.pageprops),
          });
        }
      }));
      const out = new Map();
      for (const t of titles) out.set(t, resolveCache.get(lang + '|' + t) || { canon: t, len: 0, missing: false, disamb: false });
      return out;
    }

    async function loadRedirects(lang, canon) {
      const set = new Set([canon]);
      let cont = {};
      for (let i = 0; i < 6 && cont; i++) {
        const j = await fetchJSON(apiURL(lang, Object.assign({ action: 'query', titles: canon, prop: 'redirects',
          rdlimit: 'max', rdnamespace: '0' }, cont)), 0);
        const page = j && j.query && j.query.pages && j.query.pages[0];
        for (const r of (page && page.redirects) || []) set.add(normTitle(r.title));
        cont = j && j.continue || null;
      }
      return set;
    }

    async function loadBacklinks(st) {
      let cont = {};
      while (cont && !st.dead && st.B1.size < opts.maxBacklinks) {
        let j;
        try {
          j = await fetchJSON(apiURL(st.lang, Object.assign({ action: 'query', list: 'backlinks', bltitle: st.canon,
            blnamespace: '0', bllimit: 'max', blredirect: '1' }, cont)), 2);
        } catch (e) { break; }
        for (const b of (j.query && j.query.backlinks) || []) {
          if (b.redirect) for (const r of b.redirlinks || []) st.B1.add(normTitle(r.title));
          else st.B1.add(normTitle(b.title));
        }
        cont = j.continue || null;
        st.emit();
      }
      st.backlinksDone = true;
      st.backlinksTruncated = !!cont;
      st.emit();
      if (!st.dead && st.B1.size <= opts.b2MaxB1) loadSecondRing(st);
    }

    // 冷门目标（反链少）时再往回扩一层：B2 = 链接到 B1 中页面的条目，值是它链接到几个 B1 页面。
    // 每个 B1 页面只取一页反链（≤500），按与目标的相关度排序，最多 b2Budget 个。
    async function loadSecondRing(st) {
      const members = [...st.B1].sort((a, b) => viaRank(st, b) - viaRank(st, a)).slice(0, opts.b2Budget);
      st.b2Total = members.length;
      for (const m of members) {
        if (st.dead) return;
        try {
          const j = await fetchJSON(apiURL(st.lang, { action: 'query', list: 'backlinks', bltitle: m,
            blnamespace: '0', bllimit: 'max', blfilterredir: 'nonredirects' }), 2);
          for (const b of (j.query && j.query.backlinks) || []) {
            const t = normTitle(b.title);
            if (!st.R.has(t)) st.B2.set(t, (st.B2.get(t) || 0) + 1);
          }
        } catch (e) { /* ignore */ }
        st.b2Done++;
        if (st.b2Done % 5 === 0) st.emit();
      }
      st.emit();
    }

    async function loadMoreLike(st) {
      try {
        const j = await fetchJSON(apiURL(st.lang, { action: 'query', list: 'search', srsearch: 'morelike:' + st.canon,
          srnamespace: '0', srlimit: '100', srprop: '' }), 1);
        ((j.query && j.query.search) || []).forEach((r, i) => st.ML.set(normTitle(r.title), i));
      } catch (e) { /* morelike 偶尔超时，不影响主流程 */ }
      try {
        const j = await fetchJSON(apiURL(st.lang, { action: 'query', list: 'search', srsearch: 'linksto:"' + st.canon + '"',
          srnamespace: '0', srlimit: '1', srinfo: 'totalhits', srprop: '' }), 2);
        st.backlinkTotal = j.query && j.query.searchinfo && j.query.searchinfo.totalhits || 0;
      } catch (e) { /* 只用于显示进度 */ }
      st.emit();
    }

    // 设置目标。返回的 ready 在目标规范名、重定向和目标出链都拿到后 resolve，
    // 反链在后台继续加载（st.B1 会逐步变大）。
    function setTarget(lang, title, onChange) {
      title = normTitle(title);
      if (target && target.lang === lang && target.input === title) {
        if (onChange) target.listeners.add(onChange);
        return target;
      }
      if (target) target.dead = true;
      const st = {
        lang, input: title, canon: title, dead: false,
        R: new Set([title]), B1: new Set(), B2: new Map(), OT: new Map(), ML: new Map(),
        backlinksDone: false, backlinksTruncated: false, backlinkTotal: 0, b2Done: 0, b2Total: 0,
        listeners: new Set(onChange ? [onChange] : []),
        emit() { if (!st.dead) for (const f of st.listeners) { try { f(st); } catch (e) { /* ignore */ } } },
      };
      st.ready = (async () => {
        const r = await resolveTitles(lang, [title]);
        st.canon = r.get(title).canon || title;
        st.R.add(st.canon);
        const [R, page] = await Promise.all([
          loadRedirects(lang, st.canon).catch(() => new Set()),
          parsePage(lang, st.canon).catch(() => null),
        ]);
        for (const t of R) st.R.add(t);
        if (page) st.OT = page.links;
        loadBacklinks(st);
        loadMoreLike(st);
        st.emit();
        return st;
      })();
      target = st;
      return st;
    }

    function isTarget(st, t) { return st.R.has(t); }

    function prior(st, c) {
      let p = 0;
      if (st.B1.has(c.canon)) p += 2.5;
      if (st.OT.has(c.title) || st.OT.has(c.canon)) p += 1.5;
      const ml = st.ML.has(c.canon) ? st.ML.get(c.canon) : st.ML.get(c.title);
      if (ml !== undefined) p += 1.5 * (1 - ml / 100);
      const b2 = st.B2.get(c.canon);
      if (b2) p += 1 + 0.5 * Math.log2(b2);
      if (c.disamb) p -= 0.5;
      if (c.visited) p -= opts.visitedPenalty;
      return p;
    }

    // c.early ∈ (0,1]：链接在文章里越靠前越大。同档次里少滚动就是更快。
    function score(c) {
      switch (c.tier) {
        case 0: return 1000 + c.prior + c.early;
        case 1: return 500 + c.prior + c.early;
        case 2: return 300 + 4 * Math.log2(1 + c.viaCount) + c.prior + 0.5 * c.early;
        default:
          if (!c.evaluated) return c.prior;
          return c.prior - 1 + 2 * Math.log2(1 + c.viaCount) + 0.5 * Math.log2(1 + c.otOverlap)
            + 0.8 * Math.log2(1 + c.via2Count) + 0.3 * Math.log2(1 + c.outDegree / 100);
      }
    }

    // 按 prior 给中转页排序：目标也链回它的优先。
    function viaRank(st, title) {
      let s = 0;
      if (st.OT.has(title)) s += 2;
      if (st.ML.has(title)) s += 1 - st.ML.get(title) / 100;
      return s;
    }

    /* 评估当前页面。
     *   links: [{title, text, redirect, disamb}]  当前页能点的链接（来自页面 DOM）
     *   o.onUpdate(result)   每有新信息就回调一次，result.ranked 已按推荐程度排序
     *   o.signal: {aborted}  用户换页后置 aborted=true，停止调度新请求
     *   o.visited: Set       本局已经去过的页面
     */
    async function evaluate(lang, current, links, o) {
      o = o || {};
      const onUpdate = o.onUpdate;
      const signal = o.signal || { aborted: false };
      const visited = o.visited || new Set();
      const st = target;
      if (!st) throw new Error('no target');
      await st.ready;
      current = normTitle(current);
      const byTitle = new Map();
      for (const l of links) if (l.title && l.title !== current && !byTitle.has(l.title)) byTitle.set(l.title, l);
      let cands = [...byTitle.values()].map((l, i, arr) => ({
        title: l.title, text: l.text || l.title, canon: l.title, redirect: l.redirect !== false, disamb: !!l.disamb,
        early: 1 - i / arr.length, aliases: [],
        tier: 3, prior: 0, evaluated: false, viaCount: 0, via2Count: 0, otOverlap: 0, outDegree: 0, via: [],
        viaChecked: false, visited: false,
      }));
      const markVisited = () => { for (const c of cands) c.visited = visited.has(c.title) || visited.has(c.canon); };
      markVisited();
      const result = { current, target: st.canon, ranked: [], evaluated: 0, budget: 0, done: false, st };
      const publish = () => {
        if (signal.aborted) return;
        for (const c of cands) c.score = score(c);
        result.ranked = cands.slice().sort((a, b) => b.score - a.score);
        onUpdate && onUpdate(result);
      };

      for (const c of cands) if (isTarget(st, c.title)) c.tier = 0;
      publish();
      if (cands.some(c => c.tier === 0)) { result.done = true; publish(); return result; }

      // 只有带 mw-redirect 的链接需要解析成规范标题（反链集合里存的是规范标题）。
      const redirs = cands.filter(c => c.redirect);
      const res = await resolveTitles(lang, redirs.map(c => c.title));
      for (const c of redirs) {
        const r = res.get(c.title);
        Object.assign(c, { canon: r.canon, missing: r.missing, disamb: c.disamb || r.disamb });
        if (isTarget(st, c.canon)) c.tier = 0;
      }
      // 指向同一页面的不同写法（重定向）合并成一项，别名留给页面端一起高亮。
      const byCanon = new Map();
      cands = cands.filter(c => {
        const first = byCanon.get(c.canon);
        if (!first) { byCanon.set(c.canon, c); return true; }
        first.aliases.push(c.title);
        if (c.tier < first.tier) first.tier = c.tier;
        return false;
      });
      if (current) cands = cands.filter(c => c.canon !== current);
      markVisited();
      const refreshPriors = () => { for (const c of cands) c.prior = prior(st, c); };
      refreshPriors();
      publish();
      if (cands.some(c => c.tier === 0)) { result.done = true; publish(); return result; }

      // 反链加载过程中 prior 会变，排序时每次取最新的。
      const pending = cands.filter(c => !c.missing);
      result.budget = Math.min(opts.evalBudget, pending.length);
      const tier1Count = () => cands.filter(c => c.tier === 1).length;
      const nextCandidate = () => {
        refreshPriors();
        let best = null;
        for (const c of pending) {
          if (c.evaluated || c.inflight) continue;
          const key = (st.B1.has(c.canon) ? 10 : 0) + c.prior;
          if (!best || key > best.key) best = { c, key };
        }
        if (!best) return null;
        if (tier1Count() >= opts.enoughTier1 && !st.B1.has(best.c.canon)) return null;
        return best.c;
      };

      // 旧页面排队的同名请求会因换页被丢弃（'aborted'），这时自己再请求一次。
      const getPage = async (title, prio) => {
        try { return await parsePage(lang, title, prio, signal); } catch (e) {
          if (e.message === 'aborted' && !signal.aborted) return parsePage(lang, title, prio, signal);
          throw e;
        }
      };
      let started = 0;
      const worker = async () => {
        for (;;) {
          if (signal.aborted || started >= result.budget) return;
          const c = nextCandidate();
          if (!c) return;
          started++;
          c.inflight = true;
          try {
            const page = await getPage(c.canon, 0);
            let direct = false;
            const via = [];
            let ot = 0, v2 = 0;
            for (const t of page.links.keys()) {
              if (isTarget(st, t)) { direct = true; break; }
              if (st.B1.has(t)) via.push(t);
              if (st.OT.has(t)) ot++;
              if (st.B2.has(t)) v2++;
            }
            c.evaluated = true;
            c.otOverlap = ot;
            c.via2Count = v2;
            c.outDegree = page.links.size;
            if (direct) { c.tier = 1; c.viaCount = 0; c.via = []; }
            else {
              c.viaCount = via.length;
              c.via = via.sort((a, b) => viaRank(st, b) - viaRank(st, a));
            }
          } catch (e) {
            c.evaluated = true;
            c.failed = true;
          }
          c.inflight = false;
          result.evaluated++;
          publish();
        }
      };
      await Promise.all(Array.from({ length: Math.min(opts.concurrency, result.budget) }, worker));
      if (signal.aborted) return result;

      // 没找到 2 步时，对 |L(C) ∩ B1| 最大的几个候选验证中转页（反链里有 navbox 假阳性）。
      if (!cands.some(c => c.tier === 1)) {
        const tops = cands.filter(c => c.evaluated && c.viaCount > 0)
          .sort((a, b) => score(b) - score(a)).slice(0, opts.verifyCandidates);
        await Promise.all(tops.map(async c => {
          const ok = [];
          for (const p of c.via.slice(0, opts.verifyPerCandidate)) {
            if (signal.aborted) return;
            try {
              const page = await getPage(p, 1);
              if ([...page.links.keys()].some(t => isTarget(st, t))) ok.push(p);
            } catch (e) { /* ignore */ }
          }
          c.viaChecked = true;
          if (ok.length) { c.tier = 2; c.via = ok.concat(c.via.filter(v => !ok.includes(v))); c.viaVerified = ok; }
          publish();
        }));
      }
      result.done = true;
      publish();
      return result;
    }

    return {
      setTarget, evaluate, parsePage, resolveTitles,
      get target() { return target; },
      stats() { return Object.assign({ requests: requestCount }, sched.stats()); },
    };
  }

  const api = { createSolver, normTitle, hrefToTitle, extractVisibleLinks, collectLinks, makeScheduler, DEFAULTS };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.WikiRaceCore = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);

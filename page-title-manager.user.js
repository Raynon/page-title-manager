// ==UserScript==
// @name         浏览器标签标题管家
// @namespace    https://greasyfork.org/scripts/551523
// @version      3.0.0
// @description  统一管理浏览器标签标题：清理开头的未读计数（3条消息、1 等），并把 bangumi 作品页/角色页的标题换成中文名，收藏成书签时默认名是中文。本脚本是《网页标题标签智能清理器》的重写版。
// @author       Raynon
// @license      MIT; Copyright (c) 2026 Raynon
// @match        https://*/*
// @run-at       document-start
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_registerMenuCommand
// @downloadURL  https://update.greasyfork.org/scripts/551523/%E6%B5%8F%E8%A7%88%E5%99%A8%E6%A0%87%E7%AD%BE%E6%A0%87%E9%A2%98%E7%AE%A1%E5%AE%B6.user.js
// @updateURL    https://update.greasyfork.org/scripts/551523/%E6%B5%8F%E8%A7%88%E5%99%A8%E6%A0%87%E7%AD%BE%E6%A0%87%E9%A2%98%E7%AE%A1%E5%AE%B6.meta.js
// ==/UserScript==

/**
 * 浏览器标签标题管家 v3.0.0 —— 需求与验收标准见项目 AGENTS.md。
 *
 * 三条不能违背的约定：
 *   1. 只有本脚本碰 document.title（两个改写者会互相触发，标签乱闪）
 *   2. 新值与当前标题相同就不写回 —— 写回会再次触发监听，不写才能自然收敛
 *      （所以不需要旧版那种"断开监听再重连"，那样在断开期间是盲区）
 *   3. 站点规则取不到名字必须原样返回，绝不影响通用清理
 *
 * 站点规则靠 SITE_MODULES 里的 match 判断网址，所以 @match 只留一条"全站 https"。
 * （想加 http 或别的域名时，改的是 SITE_MODULES，不用动 @match。）
 *
 * GM_getValue / GM_setValue / GM_registerMenuCommand 目前只声明未使用，留给将来的
 * 开关与每站设置（提前声明，将来加功能不必让用户重装）。v1 不要引入异步逻辑——
 * 一旦异步，"单一改写者 + 幂等"就要重新设计。
 */

/* eslint-disable no-var */

// Node 下（测试用）只导出、不自动启动；浏览器里由文件末尾自动启动
var PTM_IN_NODE = (typeof module !== 'undefined' && !!module.exports);

(function () {
    'use strict';

    // ---------------------------------------------------- 纯函数（不碰 DOM）

    /** 去掉标题开头的未读计数，如 "(3条消息)"、"(1)"、" (12) "。规则原样迁移自线上 v2.9 */
    var UNREAD_PREFIX = /^\(\d+(?:[^\)]*)?\)\s*/;

    function cleanUnread(title) {
        return String(title == null ? '' : title).replace(UNREAD_PREFIX, '');
    }

    /** 去掉末尾的站点后缀；没有该后缀时原样返回，不算错 */
    function stripSiteSuffix(title, suffix) {
        if (!suffix) return title;
        var t = String(title);
        if (t.slice(-suffix.length) !== suffix) return t;
        var head = t.slice(0, t.length - suffix.length);
        while (head.length && (head.slice(-1) === ' ' || head.slice(-1) === '\u3000')) {
            head = head.slice(0, -1);
        }
        return head;
    }

    var BG_SITE_SUFFIX = ' | Bangumi 番组计划';

    /** bangumi：把标题里的日文名换成中文名；取不到名字或保障检查不过 → null（表示不改） */
    function applyBangumi(title, info) {
        if (!info) return null;
        var zh = info.zh == null ? '' : String(info.zh).trim();
        var ja = info.ja == null ? '' : String(info.ja).trim();
        if (!zh || !ja) return null;

        // 日文名必须出现在当前标题里：万一名字取串了，也不会把标题改成别的作品。
        // 代价是页面标题用简称时会对不上、该改而不改 —— 宁可少改，不要改错。
        var src = String(title);
        if (src.indexOf(ja) < 0) return null;

        var next = src.replace(ja, zh);      // 只换第一次出现
        return stripSiteSuffix(next, BG_SITE_SUFFIX);
    }

    /** 完整管线：通用清理 → 站点规则；返回值与入参相同表示不需要改 */
    function runPipeline(title, siteRule) {
        var cleaned = cleanUnread(title);
        if (!siteRule) return cleaned;
        try {
            var next = siteRule(cleaned);
            return (typeof next === 'string') ? next : cleaned;
        } catch (e) {
            return cleaned;                  // 站点规则出错绝不影响通用清理
        }
    }

    // ------------------------------------------ bangumi 站点规则（读 DOM）

    var BG_NAME_LINK = '#headerSubject h1.nameSingle a';
    var BG_INFOBOX = '#infobox';
    var BG_TIP = 'span.tip';
    var BG_HOSTS = ['bgm.tv', 'bangumi.tv', 'chii.in'];
    // 路径必须是主页：章节页 /subject/8/ep、子页 /subject/8/comments 都不匹配
    var BG_PATH = /^\/(subject|character)\/\d+\/?$/;

    /** 把连续空白压成一个空格（HTML 里的换行缩进只是排版，不是名字的一部分） */
    function squash(text) {
        return String(text == null ? '' : text).replace(/\s+/g, ' ').trim();
    }

    function attr(el, name) {
        if (!el || typeof el.getAttribute !== 'function') return null;
        var v = el.getAttribute(name);
        return v == null ? null : String(v);
    }

    function isBgNameLink(el) {
        if (!el) return false;
        if (attr(el, 'property') === 'v:itemreviewed') return true;
        var href = attr(el, 'href') || '';
        return /^\/(subject|character)\/\d+/.test(href);
    }

    /** 左上角名字链接：优先带 property="v:itemreviewed" 的（作品页），否则取指向作品/角色主页的那个 */
    function bgNameLink(doc) {
        var links = doc.querySelectorAll(BG_NAME_LINK);
        var i, el;
        for (i = 0; i < links.length; i++) {
            el = links[i];
            if (attr(el, 'property') === 'v:itemreviewed') return el;
        }
        for (i = 0; i < links.length; i++) {
            el = links[i];
            if (isBgNameLink(el)) return el;
        }
        return links.length ? links[0] : null;
    }

    function bgJaName(doc) {
        var el = bgNameLink(doc);
        if (!el) return null;
        var text = squash(el.textContent);
        return text || null;
    }

    /**
     * 在信息栏里按标签精确取值：
     *   "中文名:" → 作品页的中文名；"简体中文名:" → 角色页的中文名。
     * 两者互不命中（角色页没有"中文名:"）；"别名""第二中文名"标签不同，且不在 #infobox 直属层，天然跳过。
     */
    function infoboxValue(doc, label) {
        var infobox = doc.querySelector(BG_INFOBOX);
        if (!infobox) return null;
        var tips = infobox.querySelectorAll(BG_TIP);
        var i, tip, normLabel = squash(label), raw, li, full, val;
        for (i = 0; i < tips.length; i++) {
            tip = tips[i];
            raw = squash(tip.textContent);
            if (raw !== normLabel) continue;
            li = tip.parentNode;
            if (!li) continue;
            full = squash(li.textContent);
            val = full.slice(raw.length).trim();
            return val || null;
        }
        return null;
    }

    /** 兜底来源：名字链接的 title 属性（用户看不见，但网页里有） */
    function bgTitleAttr(doc) {
        var el = bgNameLink(doc);
        var v = el ? attr(el, 'title') : null;
        return v ? v.trim() : null;
    }

    // 站点规则＝数据：加网站就往这个数组里追加一条，别处不用改
    var SITE_MODULES = [
        {
            id: 'bangumi',
            match: function (loc) {
                var host = loc && loc.hostname ? String(loc.hostname).replace(/\.$/, '') : '';
                return BG_HOSTS.indexOf(host) >= 0 && BG_PATH.test(loc.pathname || '');
            },
            info: function (doc, loc) {
                var path = (loc && loc.pathname) || '';
                var labels = [];
                if (/^\/subject\//.test(path)) labels = ['中文名:', '中文名'];
                else if (/^\/character\//.test(path)) labels = ['简体中文名:', '简体中文名'];
                var i, zh = null;
                for (i = 0; i < labels.length && !zh; i++) zh = infoboxValue(doc, labels[i]);
                if (!zh) zh = bgTitleAttr(doc);
                return { zh: zh, ja: bgJaName(doc) };
            },
            rewrite: applyBangumi
        }
    ];

    // ---------------------------------------- 运行外壳（唯一有副作用的地方）

    var stats = { settles: 0, writes: 0 };

    function pickModule(loc) {
        for (var i = 0; i < SITE_MODULES.length; i++) {
            try {
                if (SITE_MODULES[i].match(loc)) return SITE_MODULES[i];
            } catch (e) { /* 单个模块出错不影响其他模块 */ }
        }
        return null;
    }

    /** 跑一次管线并写回；返回 true 表示真的写了（仅在结果与当前标题不同时） */
    function settle(doc) {
        stats.settles++;
        var current = doc.title;
        var mod = pickModule(doc.location);
        var rule = null;
        if (mod) {
            var info = null;
            try { info = mod.info(doc, doc.location); } catch (e) { info = null; }
            if (info) {
                rule = function (t) { return mod.rewrite(t, info); };
            }
        }
        var next = runPipeline(current, rule);
        if (next == null || next === current) return false;
        try {
            doc.title = next;
            stats.writes++;
            return true;
        } catch (e) {
            return false;
        }
    }

    var installed = false;

    function install(sandbox) {
        var doc = sandbox.document;
        var observer = null;
        var Observer = sandbox.MutationObserver;

        var reconnect = function () {
            if (!Observer || !doc.documentElement) return;
            observer = new Observer(function () { settle(doc); });
            try {
                // 监听整棵树：这样标题还没出现时也能挂上，标题一插入就被处理
                observer.observe(doc.documentElement, { childList: true, subtree: true, characterData: true });
            } catch (e) { /* 挂不上不致命，初始那次已经处理过 */ }
        };

        var ensureTitle = function () {
            if (!doc.title && doc.head && typeof doc.createElement === 'function') {
                try { doc.head.appendChild(doc.createElement('title')); } catch (e) { /* 忽略 */ }
            }
        };

        try {
            ensureTitle();
            settle(doc);
            reconnect();
            if (!observer && doc.head && typeof doc.head.addEventListener === 'function') {
                doc.head.addEventListener('DOMNodeInserted', function () { reconnect(); });
            }
        } catch (e) {
            console.error('[浏览器标签标题管家] 初始化失败：', e);
        }

        installed = true;
        return {
            settle: function () { return settle(doc); },
            reconnect: reconnect,
            stats: stats,
            pickModule: function () { return pickModule(doc.location); }
        };
    }

    var api = {
        // 纯函数
        cleanUnread: cleanUnread,
        stripSiteSuffix: stripSiteSuffix,
        applyBangumi: applyBangumi,
        runPipeline: runPipeline,
        // 站点规则
        SITE_MODULES: SITE_MODULES,
        BG_SITE_SUFFIX: BG_SITE_SUFFIX,
        // 运行外壳
        boot: function (sandbox) { return install(sandbox); },
        isInstalled: function () { return installed; }
    };

    // 测试出口：把 api 挂到全局命名空间上，tests\run-tests.js 就能在 vm 里跑真实源码。
    // 浏览器里因为 @grant 的存在，管理器给的是隔离 window，这个命名空间不会污染页面。
    var g = (typeof globalThis !== 'undefined')
        ? globalThis
        : (typeof window !== 'undefined' ? window : this);

    if (!PTM_IN_NODE && typeof window !== 'undefined') g = window;

    if (g) {
        try {
            g.Object.defineProperty(g, '__PTM_TEST_API__', {
                value: api, writable: true, configurable: true, enumerable: false
            });
        } catch (e) {
            try { g.__PTM_TEST_API__ = api; } catch (e2) { /* 什么都不做 */ }
        }
    }

    // 浏览器：启动。Node：只挂命名空间，等测试自己 boot()
    if (!PTM_IN_NODE) {
        api.kernel = install(typeof window !== 'undefined' ? window : g);
    }

    return api;
})();

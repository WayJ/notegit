/*!
 * Notegit 共享页脚本（S12-T3，D19-A 第一步 / G10）：各页重复内联 api() fetch
 * 封装的最小公共抽取——**行为零变化**（两族语义与原内联实现逐字一致，测试
 * web-assets.test.ts 形态锁定）。普通 script 全局命名空间 window.ngt（无模块
 * 面、无构建链）；页面以 <script src="/assets/app.js"> 引用后在本页内联块
 * 顶部取用（如 `const api = ngt.api;`——调用面零改写）。
 *
 * 两族（以各页现有实现的最小公共语义为准，不新增能力）：
 * - api（edit 族——原 edit/pages.ts 内联）：message 取向 error.message || status，
 *   err.status / err.data 携带（422 报告渲染与 409 冲突 tip 分支所依）；
 * - apiEnvelope（pages.ts 族——原 login/admin/credentials 内联 FETCH_HELPER）：
 *   message 取向 "code: message"（可读信封）。
 * 共有请求语义：同源 fetch（浏览器对非安全方法自动带 Origin——不显式设头）、
 * 无 body 不带 content-type、204 短路 null、JSON 解析容错回落 {}、!ok 抛 Error。
 * 不新增能力：无 401 跳登录、无显式 Origin 头（原内联均无——保持一致）。
 */
(function () {
  'use strict';

  // —— pages.ts 族（login/admin/credentials 原内联 FETCH_HELPER 原文，仅更名避让全局单名）——
  async function apiEnvelope(method, url, body) {
    const res = await fetch(url, {
      method,
      headers: body === undefined ? {} : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (res.status === 204) return null;
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const err = data.error || {};
      throw new Error((err.code || res.status) + ': ' + (err.message || JSON.stringify(data)));
    }
    return data;
  }

  // —— edit 族（原 edit/pages.ts API_FN_JS 原文）——
  async function api(method, url, body) {
    const res = await fetch(url, {
      method,
      headers: body === undefined ? {} : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (res.status === 204) return null;
    const data = await res.json().catch(() => ({}));
    if (!res.ok) { const e = new Error((data.error && data.error.message) || res.status); e.status = res.status; e.data = data; throw e; }
    return data;
  }

  // —— 状态文案注入（原 FETCH_HELPER 同体件：textContent 唯一通道，无 innerHTML）——
  function show(el, text) { el.textContent = text; }

  window.ngt = { api: api, apiEnvelope: apiEnvelope, show: show };
})();

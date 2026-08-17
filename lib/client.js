/**
 * dsh-chat — browser half.
 *
 * Registers itself under the package id via the client module loader
 * (window.__ModuleLoader__), injects a sidebar「对话」entry at the DOM level,
 * and mounts a self-contained React chat panel in the center column. Styling
 * rides the dsh --dsw-* design tokens so it follows the active theme, and the
 * center-column takeover / sidebar-entry / back-button behavior mirrors the
 * dsh-web-ui family (task board, ssh).
 */
window.__ModuleLoader__.load({
  id: "dsh-chat",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

    const React = require("react");
    const reactDomClient = require("react-dom/client");
    const { createElement, useState, useEffect, useRef, useCallback } = React;
    const { createRoot } = reactDomClient;
    const h = createElement;

    // ---------------------------------------------------------------------
    // API client (same-origin fetch against /api/dsh-chat).
    // ---------------------------------------------------------------------
    async function apiGet(path) {
      const response = await fetch(path);
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.error || `HTTP ${response.status}`);
      return body;
    }

    function apiModels() {
      return apiGet('/api/dsh-chat/models');
    }
    function apiListConversations() {
      return apiGet('/api/dsh-chat/conversations');
    }
    function apiGetConversation(id) {
      return apiGet('/api/dsh-chat/conversations?id=' + encodeURIComponent(id));
    }
    async function apiDeleteConversation(id) {
      const response = await fetch('/api/dsh-chat/conversations?id=' + encodeURIComponent(id), { method: 'DELETE' });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.error || `HTTP ${response.status}`);
    }

    /**
     * POST /stream and consume the NDJSON frame stream.
     * @param {object} payload   { conversationId?, provider, model, text }
     * @param {object} callbacks { onMeta?, onDelta?, onReasoning?, onUsage?, onDone?, onError? }
     */
    async function apiStream(payload, callbacks) {
      const { onMeta, onDelta, onReasoning, onUsage, onDone, onError } = callbacks;
      const response = await fetch('/api/dsh-chat/stream', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (!response.ok || !response.body) {
        const text = await response.text().catch(() => '');
        let message = text || `HTTP ${response.status}`;
        if (text.startsWith('{')) {
          try { message = JSON.parse(text).error || message; } catch { /* keep raw */ }
        }
        throw new Error(message);
      }
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';
        for (const line of lines) {
          if (line.trim() === '') continue;
          let frame;
          try { frame = JSON.parse(line); } catch { continue; }
          switch (frame.type) {
            case 'meta': onMeta && onMeta(frame); break;
            case 'delta': onDelta && onDelta(frame.text); break;
            case 'reasoning': onReasoning && onReasoning(); break;
            case 'usage': onUsage && onUsage(frame.usage); break;
            case 'done': onDone && onDone(); break;
            case 'error': onError && onError(frame.error); break;
            default: break;
          }
        }
      }
    }

    // ---------------------------------------------------------------------
    // Markdown renderer (GFM subset) — escape-first + protocol allow-list,
    // mirrors the family renderers (dsh-aionui-panel preview / dsh-remote-
    // web-ui mobile chat). Pure string functions; the output only ever
    // contains the renderer's own tags.
    // ---------------------------------------------------------------------
    function escapeHtml(text) {
      return text
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;')
    }

    /**
     * Guard a raw link/image target against dangerous protocols. Returns the
     * (trimmed) raw string when safe, else null. Only http:, https:, mailto:,
     * fragment anchors (#...) and strictly relative paths are allowed; anything
     * with another scheme — javascript:, data:, vbscript:, etc. — or a
     * protocol-relative //host target is rejected so the value never reaches
     * dangerouslySetInnerHTML.
     */
    function safeUrl(raw) {
      const trimmed = raw.trim()
      if (trimmed === '') return null
      if (trimmed.startsWith('#')) return trimmed
      if (trimmed.startsWith('//')) return null
      const scheme = /^([a-zA-Z][a-zA-Z0-9+.-]*):/.exec(trimmed)
      if (scheme === null) return trimmed
      const name = scheme[1].toLowerCase()
      return name === 'http' || name === 'https' || name === 'mailto' ? trimmed : null
    }

    /** Find the ')' closing a link/image target, skipping nested parens. */
    function findCloseParen(text, from) {
      let depth = 0
      for (let i = from; i < text.length; i += 1) {
        const char = text[i]
        if (char === '(') depth += 1
        else if (char === ')') {
          if (depth === 0) return i
          depth -= 1
        }
      }
      return -1
    }

    /** Inline pass: code spans, bold, italic, strikethrough, images, links. */
    function renderInline(text) {
      let out = ''
      let i = 0
      const n = text.length
      while (i < n) {
        const char = text[i]
        // Fenced inline code first.
        if (char === '`') {
          const end = text.indexOf('`', i + 1)
          if (end !== -1) {
            out += '<code>' + escapeHtml(text.slice(i + 1, end)) + '</code>'
            i = end + 1
            continue
          }
        }
        // Image ![alt](src)
        if (char === '!' && text[i + 1] === '[') {
          const close = text.indexOf('](', i + 2)
          if (close !== -1) {
            const parenEnd = findCloseParen(text, close + 2)
            if (parenEnd !== -1) {
              const alt = text.slice(i + 2, close)
              const src = text.slice(close + 2, parenEnd)
              const safe = safeUrl(src)
              if (safe === null) {
                // Unsafe image target: drop the img, keep the alt text.
                out += escapeHtml(alt)
              } else {
                const srcEsc = escapeHtml(safe).replace(/\s+/g, '%20')
                out += '<img alt="' + escapeHtml(alt) + '" src="' + srcEsc + '" />'
              }
              i = parenEnd + 1
              continue
            }
          }
        }
        // Link [text](href)
        if (char === '[') {
          const close = text.indexOf('](', i + 1)
          if (close !== -1) {
            const parenEnd = findCloseParen(text, close + 2)
            if (parenEnd !== -1) {
              const label = text.slice(i + 1, close)
              const href = text.slice(close + 2, parenEnd)
              const safe = safeUrl(href)
              if (safe === null) {
                // Unsafe link target: render the label as plain text, no <a>.
                out += renderInline(label)
              } else {
                out += '<a href="' + escapeHtml(safe) + '" target="_blank" rel="noopener noreferrer">' + renderInline(label) + '</a>'
              }
              i = parenEnd + 1
              continue
            }
          }
        }
        // Bold **text**
        if (char === '*' && text[i + 1] === '*') {
          const end = text.indexOf('**', i + 2)
          if (end !== -1) {
            out += '<strong>' + renderInline(text.slice(i + 2, end)) + '</strong>'
            i = end + 2
            continue
          }
        }
        // Italic *text*
        if (char === '*' && text[i - 1] !== '*' && text[i + 1] !== '*') {
          const end = text.indexOf('*', i + 1)
          if (end !== -1 && text[end + 1] !== '*') {
            out += '<em>' + renderInline(text.slice(i + 1, end)) + '</em>'
            i = end + 1
            continue
          }
        }
        // Strikethrough ~~text~~
        if (char === '~' && text[i + 1] === '~') {
          const end = text.indexOf('~~', i + 2)
          if (end !== -1) {
            out += '<del>' + renderInline(text.slice(i + 2, end)) + '</del>'
            i = end + 2
            continue
          }
        }
        out += escapeHtml(char)
        i += 1
      }
      return out
    }

    /** Render a markdown document to HTML (block pass). */
    function renderMarkdown(source) {
      const lines = source.replace(/\r\n/g, '\n').split('\n')
      const out = []
      let i = 0
      const n = lines.length

      const flushParagraph = (buffer) => {
        if (buffer.length === 0) return
        out.push('<p>' + renderInline(buffer.join('\n')) + '</p>')
        buffer.length = 0
      }

      let paragraph = []
      while (i < n) {
        const line = lines[i]

        // Fenced code block.
        const fence = /^```([\w+-]*)\s*$/.exec(line)
        if (fence !== null) {
          flushParagraph(paragraph)
          const lang = fence[1] ?? ''
          i += 1
          const code = []
          while (i < n && !/^```\s*$/.test(lines[i])) {
            code.push(lines[i])
            i += 1
          }
          i += 1 // closing fence
          const langAttr = lang === '' ? '' : ' class="language-' + escapeHtml(lang) + '"'
          out.push('<pre' + langAttr + '><code>' + escapeHtml(code.join('\n')) + '</code></pre>')
          continue
        }

        // Heading.
        const heading = /^(#{1,6})\s+(.*)$/.exec(line)
        if (heading !== null) {
          flushParagraph(paragraph)
          const level = heading[1].length
          out.push('<h' + level + '>' + renderInline(heading[2] ?? '') + '</h' + level + '>')
          i += 1
          continue
        }

        // Horizontal rule.
        if (/^\s*(---+|\*\*\*+|___+)\s*$/.test(line)) {
          flushParagraph(paragraph)
          out.push('<hr />')
          i += 1
          continue
        }

        // Table: header row then separator row.
        if (line.includes('|') && i + 1 < n && /^\s*\|?[\s:|-]+\|?\s*$/.test(lines[i + 1]) && lines[i + 1].includes('-')) {
          flushParagraph(paragraph)
          const headerCells = splitTableRow(line)
          i += 2
          const rows = []
          while (i < n && lines[i].includes('|')) {
            rows.push(splitTableRow(lines[i]))
            i += 1
          }
          out.push('<table>')
          out.push('<thead><tr>' + headerCells.map((cell) => '<th>' + renderInline(cell) + '</th>').join('') + '</tr></thead>')
          if (rows.length > 0) {
            out.push('<tbody>' + rows.map((row) => '<tr>' + row.map((cell) => '<td>' + renderInline(cell) + '</td>').join('') + '</tr>').join('') + '</tbody>')
          }
          out.push('</table>')
          continue
        }

        // Blockquote (one level).
        const quote = /^>\s?(.*)$/.exec(line)
        if (quote !== null) {
          flushParagraph(paragraph)
          const body = []
          while (i < n) {
            const q = /^>\s?(.*)$/.exec(lines[i])
            if (q === null) break
            body.push(q[1] ?? '')
            i += 1
          }
          out.push('<blockquote><p>' + body.map((bodyLine) => renderInline(bodyLine)).join('<br />') + '</p></blockquote>')
          continue
        }

        // Unordered list.
        const ul = /^\s*([-*+])\s+(.*)$/.exec(line)
        if (ul !== null) {
          flushParagraph(paragraph)
          const items = []
          while (i < n) {
            const item = /^\s*([-*+])\s+(.*)$/.exec(lines[i])
            if (item === null) break
            items.push('<li>' + renderInline(item[2] ?? '') + '</li>')
            i += 1
          }
          out.push('<ul>' + items.join('') + '</ul>')
          continue
        }

        // Ordered list.
        const ol = /^\s*\d+[.)]\s+(.*)$/.exec(line)
        if (ol !== null) {
          flushParagraph(paragraph)
          const items = []
          while (i < n) {
            const item = /^\s*\d+[.)]\s+(.*)$/.exec(lines[i])
            if (item === null) break
            items.push('<li>' + renderInline(item[1] ?? '') + '</li>')
            i += 1
          }
          out.push('<ol>' + items.join('') + '</ol>')
          continue
        }

        // Blank line: flush the paragraph.
        if (line.trim() === '') {
          flushParagraph(paragraph)
          i += 1
          continue
        }

        paragraph.push(line)
        i += 1
      }
      flushParagraph(paragraph)
      return out.join('\n')
    }

    /** Split one table row into cells (respecting the leading/trailing pipes). */
    function splitTableRow(line) {
      const trimmed = line.trim()
      const inner = trimmed.startsWith('|') ? trimmed.slice(1) : trimmed
      const withoutTrailing = inner.endsWith('|') ? inner.slice(0, -1) : inner
      return withoutTrailing.split('|').map((cell) => cell.trim())
    }

    // ---------------------------------------------------------------------
    // Stylesheet — rides the dsh --dsw-* tokens (theme/skin aware).
    // ---------------------------------------------------------------------
    const CSS = `
/* --- center-column takeover (attribute-scoped, mirrors the family) --------- */
[data-pane='conversation'], [class*='centerCol'] { position: relative; }

[data-dsh-chat-view] {
  position: absolute;
  inset: 0;
  display: none;
  z-index: 60;
  background: var(--dsw-alias-bg-base);
}

html[data-dsh-chat-active]:not([data-dsh-taskboard-active]):not([data-dsh-ssh-active]) [data-dsh-chat-view] {
  display: block;
}

html[data-dsh-chat-active]:not([data-dsh-taskboard-active]):not([data-dsh-ssh-active]) [data-pane='conversation'] > :not([data-dsh-chat-view]),
html[data-dsh-chat-active]:not([data-dsh-taskboard-active]):not([data-dsh-ssh-active]) [class*='centerCol'] > :not([data-dsh-chat-view]) {
  display: none !important;
}

/* --- sidebar entry row ------------------------------------------------------- */
.dsh-chat-entry {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  height: 32px;
  padding: 0 12px;
  background: transparent;
  border: none;
  border-radius: 8px;
  color: var(--dsw-alias-label-secondary);
  cursor: pointer;
  font-size: 13px;
  white-space: nowrap;
}
.dsh-chat-entry:hover { background: var(--dsw-specific-sidebar-nav-item-hover); color: var(--dsw-alias-label-primary); }
.dsh-chat-entry[data-active] { background: var(--dsw-specific-sidebar-nav-item-active); color: var(--dsw-alias-label-primary); font-weight: 600; }
.dsh-chat-entry-icon { display: inline-flex; align-items: center; justify-content: center; flex: none; }
.dsh-chat-entry-label { overflow: hidden; text-overflow: ellipsis; }

[data-dsh-frame][data-sidebar-collapsed] .dsh-chat-entry { justify-content: center; padding: 0; width: 100%; }
[data-dsh-frame][data-sidebar-collapsed] .dsh-chat-entry-label { display: none; }

/* --- panel frame -------------------------------------------------------------- */
.dsh-chat-root {
  display: flex; flex-direction: column; height: 100%; min-width: 0; min-height: 0;
  padding: 14px 16px 16px; gap: 10px; box-sizing: border-box;
  background: var(--dsw-alias-bg-base); color: var(--dsw-alias-label-primary);
  font-family: var(--dsw-font-family);
}
.dsh-chat-top { display: flex; align-items: center; gap: 10px; flex: none; }
.dsh-chat-title { margin: 0; flex: 1; font-size: 16px; font-weight: 700; color: var(--dsw-alias-label-primary); white-space: nowrap; }
.dsh-chat-back { display: inline-flex; align-items: center; gap: 4px; }
.dsh-chat-body { display: flex; flex: 1 1 auto; min-height: 0; }
.dsh-chat-list { width: 212px; flex: 0 0 auto; border-right: 1px solid var(--dsw-alias-border-l1); overflow-y: auto; padding: 8px; }
.dsh-chat-list-item { display: flex; align-items: center; gap: 4px; padding: 8px 10px; margin-bottom: 2px; border-radius: 8px; cursor: pointer; white-space: nowrap; overflow: hidden; font-size: 13px; color: var(--dsw-alias-label-secondary); transition: background .15s ease, color .15s ease; }
.dsh-chat-list-item:hover { background: var(--dsw-alias-interactive-bg-hover, var(--dsw-alias-bg-layer-2)); color: var(--dsw-alias-label-primary); }
.dsh-chat-list-item.active { background: var(--dsw-alias-interactive-bg-hover, var(--dsw-alias-bg-layer-2)); color: var(--dsw-alias-label-primary); font-weight: 600; box-shadow: inset 2px 0 0 var(--dsw-alias-brand-primary, #4f7cff); }
.dsh-chat-list-title { flex: 1 1 auto; overflow: hidden; text-overflow: ellipsis; }
.dsh-chat-list-del { flex: 0 0 auto; opacity: 0; border: none; background: none; cursor: pointer; font-size: 12px; color: var(--dsw-alias-label-secondary); border-radius: 4px; padding: 2px 4px; transition: opacity .15s ease, color .15s ease; }
.dsh-chat-list-item:hover .dsh-chat-list-del { opacity: .7; }
.dsh-chat-list-del:hover { color: var(--dsw-alias-state-error-primary); }
.dsh-chat-main { flex: 1 1 auto; display: flex; flex-direction: column; min-width: 0; }
.dsh-chat-scroll { flex: 1 1 auto; overflow-y: auto; padding: 22px 20px 10px; scroll-behavior: smooth; }
.dsh-chat-scroll::-webkit-scrollbar { width: 8px; }
.dsh-chat-scroll::-webkit-scrollbar-track { background: transparent; }
.dsh-chat-scroll::-webkit-scrollbar-thumb { background: rgba(127, 127, 127, .28); border-radius: 4px; }
.dsh-chat-scroll::-webkit-scrollbar-thumb:hover { background: rgba(127, 127, 127, .45); }

/* --- message rows: avatar + bubble ------------------------------------------ */
.dsh-chat-msg-row { display: flex; align-items: flex-start; gap: 10px; margin-bottom: 18px; animation: dsh-chat-msg-in .28s cubic-bezier(.2, .8, .3, 1); }
.dsh-chat-msg-row.user { flex-direction: row-reverse; }
@keyframes dsh-chat-msg-in { from { opacity: 0; transform: translateY(8px); } to { opacity: 1; transform: none; } }
.dsh-chat-avatar { flex: 0 0 auto; width: 30px; height: 30px; border-radius: 10px; display: inline-flex; align-items: center; justify-content: center; font-size: 13px; font-weight: 600; user-select: none; margin-top: 2px; }
.dsh-chat-avatar.user { background-color: var(--dsw-alias-brand-primary, #4f7cff); background-image: linear-gradient(135deg, rgba(255, 255, 255, .18), rgba(255, 255, 255, 0) 58%); color: var(--dsw-alias-label-primary-foreground, #fff); box-shadow: 0 2px 6px rgba(0, 0, 0, .16); }
.dsh-chat-avatar.assistant { background: var(--dsw-alias-bg-layer-1, var(--dsw-alias-bg-layer-2)); border: 1px solid var(--dsw-alias-border-l1); color: var(--dsw-alias-brand-primary, #4f7cff); }
.dsh-chat-msg { max-width: 72%; min-width: 0; padding: 10px 14px; border-radius: 14px; font-size: 14px; line-height: 1.7; white-space: pre-wrap; word-break: break-word; overflow-wrap: anywhere; transition: box-shadow .15s ease; }
.dsh-chat-msg.user { background-color: var(--dsw-alias-brand-primary, #4f7cff); background-image: linear-gradient(135deg, rgba(255, 255, 255, .14), rgba(255, 255, 255, 0) 60%); color: var(--dsw-alias-label-primary-foreground, #fff); border-bottom-right-radius: 4px; box-shadow: 0 2px 8px rgba(0, 0, 0, .14); }
.dsh-chat-msg.assistant { background: var(--dsw-alias-bg-layer-1, var(--dsw-alias-bg-layer-2)); border: 1px solid var(--dsw-alias-border-l1); color: var(--dsw-alias-label-primary); border-bottom-left-radius: 4px; box-shadow: 0 1px 3px rgba(0, 0, 0, .05); }
.dsh-chat-msg.assistant:hover { box-shadow: 0 3px 10px rgba(0, 0, 0, .08); }

/* --- markdown body inside bubbles ---------------------------------------- */
.dsh-chat-md { white-space: normal; word-break: break-word; overflow-wrap: anywhere; }
.dsh-chat-md > :first-child { margin-top: 0; }
.dsh-chat-md > :last-child { margin-bottom: 0; }
.dsh-chat-md p { margin: 0 0 8px; }
.dsh-chat-md h1, .dsh-chat-md h2, .dsh-chat-md h3, .dsh-chat-md h4, .dsh-chat-md h5, .dsh-chat-md h6 { margin: 12px 0 6px; font-weight: 650; line-height: 1.3; }
.dsh-chat-md h1 { font-size: 1.35em; }
.dsh-chat-md h2 { font-size: 1.25em; }
.dsh-chat-md h3 { font-size: 1.15em; }
.dsh-chat-md h4, .dsh-chat-md h5, .dsh-chat-md h6 { font-size: 1.05em; }
.dsh-chat-md code {
  font-family: var(--ds-font-family-code, ui-monospace, SFMono-Regular, Menlo, Consolas, monospace);
  font-size: .9em;
  background: var(--dsw-alias-markdown-code-block, rgba(127, 127, 127, .16));
  padding: 1px 5px;
  border-radius: 4px;
}
.dsh-chat-md pre {
  margin: 8px 0;
  padding: 10px 12px;
  background: var(--dsw-alias-markdown-code-block, #101726);
  border-radius: 8px;
  overflow-x: auto;
  font-size: 12.5px;
  line-height: 1.5;
}
.dsh-chat-md pre code { background: transparent; padding: 0; color: inherit; font-size: inherit; }
.dsh-chat-md ul, .dsh-chat-md ol { margin: 4px 0 8px; padding-left: 22px; }
.dsh-chat-md li { margin: 2px 0; }
.dsh-chat-md blockquote { margin: 8px 0; padding: 4px 10px; border-left: 3px solid var(--dsw-alias-brand-primary, #4f7cff); background: var(--dsw-alias-markdown-code-block, rgba(127, 127, 127, .12)); border-radius: 0 6px 6px 0; }
.dsh-chat-md table { margin: 8px 0; border-collapse: collapse; display: block; overflow-x: auto; font-size: 13px; max-width: 100%; }
.dsh-chat-md th, .dsh-chat-md td { border: 1px solid var(--dsw-alias-border-l1); padding: 4px 8px; }
.dsh-chat-md th { background: var(--dsw-alias-markdown-code-block, rgba(127, 127, 127, .12)); }
.dsh-chat-md a { color: var(--dsw-alias-brand-primary, #4f7cff); }
.dsh-chat-md hr { border: none; border-top: 1px solid var(--dsw-alias-border-l1); margin: 10px 0; }
.dsh-chat-md img { max-width: 100%; border-radius: 8px; }

/* markdown inside the brand-colored user bubble stays readable on accent */
.dsh-chat-msg.user .dsh-chat-md a { color: inherit; text-decoration: underline; }
.dsh-chat-msg.user .dsh-chat-md code { background: rgba(255, 255, 255, .18); }
.dsh-chat-msg.user .dsh-chat-md pre { background: rgba(0, 0, 0, .3); }
.dsh-chat-msg.user .dsh-chat-md blockquote { border-left-color: rgba(255, 255, 255, .55); background: rgba(255, 255, 255, .12); }
.dsh-chat-msg.user .dsh-chat-md th, .dsh-chat-msg.user .dsh-chat-md td { border-color: rgba(255, 255, 255, .35); }
.dsh-chat-msg.user .dsh-chat-md th { background: rgba(255, 255, 255, .14); }
.dsh-chat-msg.user .dsh-chat-md hr { border-top-color: rgba(255, 255, 255, .35); }

/* --- thinking dots ------------------------------------------------------------ */
.dsh-chat-thinking { display: inline-flex; align-items: center; gap: 5px; padding-top: 14px; padding-bottom: 14px; }
.dsh-chat-thinking i { width: 6px; height: 6px; border-radius: 50%; background: var(--dsw-alias-label-tertiary, var(--dsw-alias-label-secondary)); animation: dsh-chat-bounce 1.2s ease-in-out infinite; }
.dsh-chat-thinking i:nth-child(2) { animation-delay: .15s; }
.dsh-chat-thinking i:nth-child(3) { animation-delay: .3s; }
@keyframes dsh-chat-bounce { 0%, 60%, 100% { transform: translateY(0); opacity: .4; } 30% { transform: translateY(-4px); opacity: 1; } }

.dsh-chat-err { margin: 0 0 14px; padding: 10px 14px; border-radius: 10px; font-size: 13px; border: 1px solid var(--dsw-alias-state-error-primary); background: rgba(255, 77, 79, .08); border-color: color-mix(in srgb, var(--dsw-alias-state-error-primary) 40%, transparent); background: color-mix(in srgb, var(--dsw-alias-state-error-primary) 8%, transparent); color: var(--dsw-alias-state-error-primary); }

/* --- floating composer card ---------------------------------------------------- */
.dsh-chat-composer { flex: 0 0 auto; display: flex; align-items: flex-end; gap: 8px; margin: 2px 14px 14px; padding: 10px; border: 1px solid var(--dsw-alias-border-l1); border-radius: 16px; background: var(--dsw-alias-bg-layer-1, var(--dsw-alias-bg-base)); box-shadow: 0 4px 18px rgba(0, 0, 0, .06); transition: border-color .15s ease, box-shadow .15s ease; }
.dsh-chat-composer:focus-within { border-color: var(--dsw-alias-brand-primary, #4f7cff); box-shadow: 0 4px 18px rgba(0, 0, 0, .08), 0 0 0 3px rgba(127, 127, 127, .22); box-shadow: 0 4px 18px rgba(0, 0, 0, .08), 0 0 0 3px color-mix(in srgb, var(--dsw-alias-brand-primary, #4f7cff) 16%, transparent); }
.dsh-chat-input { flex: 1 1 auto; resize: none; min-height: 24px; max-height: calc(100vh / 3); padding: 5px 6px; border: none; font: inherit; font-size: 14px; line-height: 1.6; background: transparent; color: var(--dsw-alias-label-primary); }
.dsh-chat-input:focus { outline: none; }
.dsh-chat-input::placeholder { color: var(--dsw-alias-label-tertiary, var(--dsw-alias-label-secondary)); }
.dsh-chat-input:disabled { opacity: .6; }
.dsh-chat-selects { display: flex; gap: 6px; flex: 0 0 auto; }
.dsh-chat-select { padding: 6px 8px; border: 1px solid var(--dsw-alias-border-l1); border-radius: 8px; font-family: inherit; font-size: 12px; background: var(--dsw-alias-bg-layer-2, transparent); color: var(--dsw-alias-label-secondary); max-width: 150px; cursor: pointer; }
.dsh-chat-select:hover { color: var(--dsw-alias-label-primary); }
.dsh-chat-select:focus { border-color: var(--dsw-alias-brand-primary, #4f7cff); outline: none; color: var(--dsw-alias-label-primary); }
.dsh-chat-btn { flex: 0 0 auto; padding: 8px 18px; border: none; border-radius: 10px; background-color: var(--dsw-alias-brand-primary, #4f7cff); background-image: linear-gradient(135deg, rgba(255, 255, 255, .16), rgba(255, 255, 255, 0) 58%); color: var(--dsw-alias-label-primary-foreground, #fff); cursor: pointer; font: inherit; font-weight: 600; box-shadow: 0 2px 8px rgba(0, 0, 0, .16); transition: transform .12s ease, box-shadow .15s ease, filter .15s ease; }
.dsh-chat-btn:hover:not(:disabled) { filter: brightness(1.06); transform: translateY(-1px); box-shadow: 0 4px 12px rgba(0, 0, 0, .2); }
.dsh-chat-btn:active:not(:disabled) { transform: translateY(0); box-shadow: 0 1px 4px rgba(0, 0, 0, .16); }
.dsh-chat-btn:disabled { opacity: .45; cursor: default; box-shadow: none; }
.dsh-chat-ghost { padding: 5px 12px; font-size: 12px; color: var(--dsw-alias-label-primary); background: transparent; border: 1px solid var(--dsw-alias-border-l2); border-radius: 8px; cursor: pointer; white-space: nowrap; transition: background .15s ease; }
.dsh-chat-ghost:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover, var(--dsw-alias-bg-layer-2)); }

/* --- empty state ---------------------------------------------------------------- */
.dsh-chat-empty { display: flex; flex-direction: column; align-items: center; gap: 10px; margin-top: 68px; color: var(--dsw-alias-label-tertiary, var(--dsw-alias-label-secondary)); font-size: 14px; }
.dsh-chat-empty-icon { width: 56px; height: 56px; border-radius: 18px; display: flex; align-items: center; justify-content: center; background: var(--dsw-alias-bg-layer-2); border: 1px solid var(--dsw-alias-border-l1); color: var(--dsw-alias-brand-primary, #4f7cff); box-shadow: 0 4px 14px rgba(0, 0, 0, .06); }
.dsh-chat-empty-hint { font-size: 12px; opacity: .75; }

/* --- settings modal ---------------------------------------------------------- */
.dsh-chat-settings-btn { display: inline-flex; align-items: center; justify-content: center; padding: 5px 8px; }
.dsh-chat-modal-backdrop { position: fixed; inset: 0; z-index: 200; display: flex; align-items: center; justify-content: center; background: rgba(0, 0, 0, .45); animation: dsh-chat-fade .15s ease; }
.dsh-chat-modal { width: 380px; max-width: calc(100vw - 48px); box-sizing: border-box; display: flex; flex-direction: column; gap: 12px; padding: 16px; border: 1px solid var(--dsw-alias-border-l1); border-radius: 16px; background: var(--dsw-alias-bg-base); color: var(--dsw-alias-label-primary); font-family: var(--dsw-font-family); box-shadow: 0 12px 40px rgba(0, 0, 0, .3); animation: dsh-chat-modal-in .18s cubic-bezier(.2, .8, .3, 1); }
@keyframes dsh-chat-fade { from { opacity: 0; } to { opacity: 1; } }
@keyframes dsh-chat-modal-in { from { opacity: 0; transform: translateY(10px) scale(.98); } to { opacity: 1; transform: none; } }
.dsh-chat-modal-top { display: flex; align-items: center; gap: 8px; }
.dsh-chat-modal-title { flex: 1; margin: 0; font-size: 15px; font-weight: 700; }
.dsh-chat-modal-close { padding: 4px 8px; }
.dsh-chat-setting-row { display: flex; align-items: center; gap: 8px; font-size: 13px; color: var(--dsw-alias-label-primary); cursor: pointer; user-select: none; }
.dsh-chat-setting-row input[type='checkbox'] { width: 14px; height: 14px; flex: none; accent-color: var(--dsw-alias-brand-primary, #4f7cff); }
.dsh-chat-modal-field { display: flex; flex-direction: column; gap: 6px; }
.dsh-chat-modal-field-label { font-size: 13px; color: var(--dsw-alias-label-secondary); }
.dsh-chat-modal-field-controls { display: flex; gap: 8px; }
.dsh-chat-modal-field-controls .dsh-chat-select { flex: 1 1 0; min-width: 0; max-width: none; }
.dsh-chat-setting-hint { font-size: 12px; line-height: 1.5; color: var(--dsw-alias-label-tertiary, var(--dsw-alias-label-secondary)); }
.dsh-chat-modal-actions { display: flex; justify-content: flex-end; margin-top: 2px; }

.dsh-chat-caret { display: inline-block; margin-left: 3px; width: 2px; height: 1em; vertical-align: -.15em; background: var(--dsw-alias-brand-primary, #4f7cff); animation: dsh-chat-blink 1s steps(2) infinite; }
@keyframes dsh-chat-blink { 50% { opacity: 0; } }
`;

    // ---------------------------------------------------------------------
    // Chat panel React component.
    // ---------------------------------------------------------------------
    function ChatPanel(props) {
      const onClose = props && props.onClose ? props.onClose : null;

      const [providers, setProviders] = useState([]);
      const [models, setModels] = useState([]);
      const [provider, setProvider] = useState('');
      const [model, setModel] = useState('');
      const [conversations, setConversations] = useState([]);
      const [activeId, setActiveId] = useState(null);
      const [messages, setMessages] = useState([]);
      const [input, setInput] = useState('');
      const [streaming, setStreaming] = useState(false);
      const [streamText, setStreamText] = useState('');
      const [thinking, setThinking] = useState(false);
      const [error, setError] = useState('');

      const [settingsOpen, setSettingsOpen] = useState(false);
      const [titleEnabled, setTitleEnabled] = useState(true);
      const [titleProvider, setTitleProvider] = useState('');
      const [titleModel, setTitleModel] = useState('');
      const timersRef = useRef([]);

      const activeIdRef = useRef(null);
      activeIdRef.current = activeId;
      const scrollRef = useRef(null);
      const inputRef = useRef(null);

      const refreshConversations = useCallback(async () => {
        try {
          const res = await apiListConversations();
          setConversations(res.conversations || []);
        } catch { /* list refresh is best-effort */ }
      }, []);

      // Load the model directory once.
      useEffect(() => {
        let cancelled = false;
        apiModels().then((res) => {
          if (cancelled) return;
          const providers = res.providers || [];
          const models = res.models || [];
          setProviders(providers);
          setModels(models);
          let saved = null;
          try { saved = JSON.parse(localStorage.getItem('dsh-chat.model') || 'null'); } catch { saved = null; }
          let chosenProvider = '';
          let chosenModel = '';
          if (saved && providers.some(p => p.id === saved.provider)) {
            chosenProvider = saved.provider;
            if (models.some(m => m.provider === saved.provider && m.id === saved.model)) {
              chosenModel = saved.model;
            }
          }
          if (chosenProvider === '') {
            chosenProvider = providers.length > 0 ? providers[0].id : '';
            const first = models.find(m => m.provider === chosenProvider);
            chosenModel = first ? first.id : '';
          }
          setProvider(chosenProvider);
          setModel(chosenModel);

          // Title-generation preference: enabled by default; the model defaults
          // to the chat's own provider/model when nothing was saved (or the
          // saved choice is no longer available).
          let savedTitle = null;
          try { savedTitle = JSON.parse(localStorage.getItem('dsh-chat.titleModel') || 'null'); } catch { savedTitle = null; }
          if (savedTitle && savedTitle.enabled === false) setTitleEnabled(false);
          let titleProviderValue = '';
          let titleModelValue = '';
          if (savedTitle && typeof savedTitle.provider === 'string' && providers.some(p => p.id === savedTitle.provider)) {
            titleProviderValue = savedTitle.provider;
            if (typeof savedTitle.model === 'string' && models.some(m => m.provider === savedTitle.provider && m.id === savedTitle.model)) {
              titleModelValue = savedTitle.model;
            }
          }
          if (titleProviderValue === '') {
            titleProviderValue = chosenProvider;
            titleModelValue = chosenModel;
          }
          setTitleProvider(titleProviderValue);
          setTitleModel(titleModelValue);
        }).catch((e) => setError(e.message || String(e)));
        return () => { cancelled = true; };
      }, []);

      useEffect(() => { refreshConversations(); }, [refreshConversations]);

      useEffect(() => {
        if (provider && model) {
          try { localStorage.setItem('dsh-chat.model', JSON.stringify({ provider, model })); } catch { /* ignore */ }
        }
      }, [provider, model]);

      // Persist the title-generation preference.
      useEffect(() => {
        if (titleProvider && titleModel) {
          try {
            localStorage.setItem('dsh-chat.titleModel', JSON.stringify({ enabled: titleEnabled, provider: titleProvider, model: titleModel }));
          } catch { /* ignore */ }
        }
      }, [titleEnabled, titleProvider, titleModel]);

      // Clear any pending delayed refreshes on unmount.
      useEffect(() => {
        return () => { timersRef.current.forEach(clearTimeout); timersRef.current = []; };
      }, []);

      // Close the settings modal with Escape.
      useEffect(() => {
        if (!settingsOpen) return;
        const onKeyDown = (event) => { if (event.key === 'Escape') setSettingsOpen(false); };
        document.addEventListener('keydown', onKeyDown);
        return () => document.removeEventListener('keydown', onKeyDown);
      }, [settingsOpen]);

      useEffect(() => {
        const node = scrollRef.current;
        if (node) node.scrollTop = node.scrollHeight;
      }, [messages, streamText, thinking]);

      const openConversation = useCallback(async (id) => {
        setActiveId(id);
        setStreamText('');
        setThinking(false);
        setError('');
        try {
          const res = await apiGetConversation(id);
          setMessages(res.conversation.messages || []);
        } catch (e) {
          setError(e.message || String(e));
        }
      }, []);

      const newChat = useCallback(() => {
        setActiveId(null);
        setMessages([]);
        setStreamText('');
        setThinking(false);
        setError('');
      }, []);

      const deleteConversation = useCallback(async (id, event) => {
        if (event) { event.stopPropagation(); }
        try {
          await apiDeleteConversation(id);
          if (activeIdRef.current === id) newChat();
          await refreshConversations();
        } catch (e) {
          setError(e.message || String(e));
        }
      }, [activeIdRef, newChat, refreshConversations]);

      const send = useCallback(async () => {
        const text = input.trim();
        if (text === '' || streaming) return;
        setInput('');
        if (inputRef.current) inputRef.current.style.height = 'auto';
        setError('');
        setStreaming(true);
        setStreamText('');
        setThinking(false);
        const targetId = activeId ?? '';
        const wasNew = targetId === '';
        setMessages(prev => [...prev, { role: 'user', content: text }]);
        let acc = '';
        let finalized = false;
        const finalize = (ok, err) => {
          if (finalized) return;
          finalized = true;
          setStreaming(false);
          setStreamText('');
          setThinking(false);
          if (!ok) setError(err || '生成失败');
          refreshConversations();
          if (titleEnabled) {
            // The AI title may land shortly after the reply finishes; a couple
            // of quiet refreshes pick it up without polling.
            timersRef.current.forEach(clearTimeout);
            timersRef.current = [
              setTimeout(refreshConversations, 1500),
              setTimeout(refreshConversations, 4000),
            ];
          }
          const id = activeIdRef.current ?? targetId;
          if (id) {
            apiGetConversation(id).then(res => setMessages(res.conversation.messages || [])).catch(() => {});
          }
        };
        try {
          await apiStream(
            {
              conversationId: targetId,
              provider,
              model,
              text,
              titleEnabled,
              titleProvider: titleProvider || provider,
              titleModel: titleModel || model,
            },
            {
              onMeta: (frame) => {
                if (wasNew && frame.conversationId) setActiveId(frame.conversationId);
              },
              onDelta: (t) => { acc += t; setStreamText(acc); },
              onReasoning: () => setThinking(true),
              onUsage: () => {},
              onDone: () => finalize(true),
              onError: (err) => finalize(false, err),
            },
          );
          finalize(true);
        } catch (e) {
          finalize(false, e.message || String(e));
        }
      }, [input, streaming, activeId, provider, model, titleEnabled, titleProvider, titleModel, refreshConversations, activeIdRef]);

      const onKeyDown = useCallback((event) => {
        if (event.key === 'Enter' && !event.shiftKey) {
          event.preventDefault();
          send();
        }
      }, [send]);

      const modelOptions = models.filter(m => m.provider === provider);
      const titleModelOptions = models.filter(m => m.provider === titleProvider);
      const changeProvider = useCallback((value) => {
        setProvider(value);
        const first = models.find(m => m.provider === value);
        setModel(first ? first.id : '');
      }, [models]);

      return h('div', { className: 'dsh-chat-root' },
        h('div', { className: 'dsh-chat-top' },
          onClose
            ? h('button', { className: 'dsh-chat-ghost dsh-chat-back', onClick: onClose, type: 'button' }, '← 返回')
            : null,
          h('div', { className: 'dsh-chat-title' }, '对话'),
          h('button', {
            className: 'dsh-chat-ghost dsh-chat-settings-btn',
            type: 'button',
            title: '设置',
            onClick: () => setSettingsOpen(!settingsOpen),
            dangerouslySetInnerHTML: { __html: ICON_GEAR },
          }),
          h('button', { className: 'dsh-chat-btn', onClick: newChat, type: 'button' }, '新对话'),
        ),
        settingsOpen
          ? h('div', {
              className: 'dsh-chat-modal-backdrop',
              onClick: () => setSettingsOpen(false),
            },
              h('div', {
                className: 'dsh-chat-modal',
                role: 'dialog',
                'aria-modal': 'true',
                'aria-label': '对话设置',
                onClick: (event) => event.stopPropagation(),
              },
                h('div', { className: 'dsh-chat-modal-top' },
                  h('div', { className: 'dsh-chat-modal-title' }, '对话设置'),
                  h('button', {
                    className: 'dsh-chat-ghost dsh-chat-modal-close',
                    type: 'button',
                    title: '关闭',
                    onClick: () => setSettingsOpen(false),
                  }, '✕'),
                ),
                h('label', { className: 'dsh-chat-setting-row' },
                  h('input', {
                    type: 'checkbox',
                    checked: titleEnabled,
                    onChange: (event) => setTitleEnabled(event.target.checked),
                  }),
                  h('span', null, '用 AI 根据提问生成对话标题'),
                ),
                h('div', { className: 'dsh-chat-modal-field' },
                  h('div', { className: 'dsh-chat-modal-field-label' }, '标题生成模型'),
                  h('div', { className: 'dsh-chat-modal-field-controls' },
                    h('select', {
                      className: 'dsh-chat-select',
                      value: titleProvider,
                      disabled: !titleEnabled || providers.length === 0,
                      onChange: (event) => {
                        const value = event.target.value;
                        setTitleProvider(value);
                        const first = models.find(m => m.provider === value);
                        setTitleModel(first ? first.id : '');
                      },
                    },
                      providers.map(p => h('option', { key: p.id, value: p.id }, p.name)),
                    ),
                    h('select', {
                      className: 'dsh-chat-select',
                      value: titleModel,
                      disabled: !titleEnabled || titleProvider === '',
                      onChange: (event) => setTitleModel(event.target.value),
                    },
                      titleModelOptions.map(m => h('option', { key: m.id, value: m.id }, m.name)),
                    ),
                  ),
                ),
                h('div', { className: 'dsh-chat-setting-hint' }, 'AI 标题取自你的第一条提问;生成失败或关闭时回退为提问截断。'),
                h('div', { className: 'dsh-chat-modal-actions' },
                  h('button', { className: 'dsh-chat-btn', type: 'button', onClick: () => setSettingsOpen(false) }, '完成'),
                ),
              ),
            )
          : null,
        h('div', { className: 'dsh-chat-body' },
          h('div', { className: 'dsh-chat-list' },
            conversations.map(conversation =>
              h('div', {
                key: conversation.id,
                className: 'dsh-chat-list-item' + (conversation.id === activeId ? ' active' : ''),
                onClick: () => openConversation(conversation.id),
              },
                h('span', { className: 'dsh-chat-list-title' }, conversation.title || '新对话'),
                h('button', {
                  className: 'dsh-chat-list-del',
                  type: 'button',
                  title: '删除',
                  onClick: (event) => deleteConversation(conversation.id, event),
                }, '✕'),
              ),
            ),
          ),
          h('div', { className: 'dsh-chat-main' },
            h('div', { className: 'dsh-chat-scroll', ref: scrollRef },
              messages.length === 0 && !streaming
                ? h('div', { className: 'dsh-chat-empty' },
                    h('div', { className: 'dsh-chat-empty-icon', dangerouslySetInnerHTML: { __html: ICON_EMPTY } }),
                    h('div', null, '开始一段普通对话吧'),
                    h('div', { className: 'dsh-chat-empty-hint' }, '不绑工作区、不带工具 · Enter 发送，Shift+Enter 换行'),
                  )
                : null,
              messages.map((message, index) =>
                h('div', {
                  key: index,
                  className: 'dsh-chat-msg-row ' + (message.role === 'user' ? 'user' : 'assistant'),
                },
                  message.role === 'user'
                    ? h('div', { className: 'dsh-chat-avatar user' }, '我')
                    : h('div', { className: 'dsh-chat-avatar assistant', dangerouslySetInnerHTML: { __html: ICON_SPARK } }),
                  h('div', {
                    className: 'dsh-chat-msg ' + (message.role === 'user' ? 'user' : 'assistant'),
                  },
                    h('div', { className: 'dsh-chat-md', dangerouslySetInnerHTML: { __html: renderMarkdown(message.content) } }),
                  ),
                ),
              ),
              streaming && streamText === ''
                ? h('div', { className: 'dsh-chat-msg-row assistant' },
                    h('div', { className: 'dsh-chat-avatar assistant', dangerouslySetInnerHTML: { __html: ICON_SPARK } }),
                    h('div', { className: 'dsh-chat-msg assistant dsh-chat-thinking' }, h('i'), h('i'), h('i')),
                  )
                : null,
              streaming && streamText !== ''
                ? h('div', { className: 'dsh-chat-msg-row assistant' },
                    h('div', { className: 'dsh-chat-avatar assistant', dangerouslySetInnerHTML: { __html: ICON_SPARK } }),
                    h('div', { className: 'dsh-chat-msg assistant' },
                      h('div', { className: 'dsh-chat-md', dangerouslySetInnerHTML: { __html: renderMarkdown(streamText) } }),
                      h('span', { className: 'dsh-chat-caret' }),
                    ),
                  )
                : null,
              error !== ''
                ? h('div', { className: 'dsh-chat-err' }, error)
                : null,
            ),
            h('div', { className: 'dsh-chat-composer' },
              h('textarea', {
                className: 'dsh-chat-input',
                ref: inputRef,
                rows: 1,
                value: input,
                placeholder: '输入内容，Enter 发送，Shift+Enter 换行',
                onChange: (event) => {
                  setInput(event.target.value);
                  const el = event.target;
                  el.style.height = 'auto';
                  el.style.height = Math.min(el.scrollHeight, Math.floor(window.innerHeight / 3)) + 'px';
                },
                onKeyDown,
                disabled: streaming,
              }),
              h('div', { className: 'dsh-chat-selects' },
                h('select', {
                  className: 'dsh-chat-select',
                  value: provider,
                  onChange: (event) => changeProvider(event.target.value),
                  title: '模型提供商',
                },
                  providers.map(p => h('option', { key: p.id, value: p.id }, p.name)),
                ),
                h('select', {
                  className: 'dsh-chat-select',
                  value: model,
                  onChange: (event) => setModel(event.target.value),
                  title: '模型',
                },
                  modelOptions.map(m => h('option', { key: m.id, value: m.id }, m.name)),
                ),
              ),
              h('button', {
                className: 'dsh-chat-btn',
                onClick: send,
                disabled: streaming || input.trim() === '' || provider === '' || model === '',
                type: 'button',
              }, streaming ? '生成中…' : '发送'),
            ),
          ),
        ),
      );
    }

    // ---------------------------------------------------------------------
    // Sidebar entry + center-column panel mount (DOM level, self-healing).
    // ---------------------------------------------------------------------
    const ENTRY_ATTR = 'data-dsh-chat-entry';
    const VIEW_ATTR = 'data-dsh-chat-view';
    const ACTIVE_ATTR = 'data-dsh-chat-active';
    const OTHER_ACTIVE_ATTRS = ['data-dsh-taskboard-active', 'data-dsh-ssh-active'];
    const ACTIVATE_EVENT = 'dsh-panel-activate';
    const PANEL_NAME = 'chat';

    const ICON = '<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14 7.5a5.5 5.5 0 0 1-8 4.9L3 13l.6-3A5.5 5.5 0 1 1 14 7.5z"/></svg>';
    const ICON_SPARK = '<svg viewBox="0 0 16 16" width="15" height="15" fill="currentColor" aria-hidden="true"><path d="M8 1.5l1.6 4.2 4.2 1.6-4.2 1.6L8 13.1l-1.6-4.2-4.2-1.6 4.2-1.6z"/></svg>';
    const ICON_EMPTY = '<svg viewBox="0 0 24 24" width="26" height="26" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 11.5a8.5 8.5 0 0 1-12.4 7.5L3 21l2-5.6A8.5 8.5 0 1 1 21 11.5z"/><path d="M8.5 10.5h7M8.5 13.5h4"/></svg>';
    const ICON_GEAR = '<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="8" cy="8" r="2.2"/><path d="M8 1.8v1.7M8 12.5v1.7M1.8 8h1.7M12.5 8h1.7M3.6 3.6l1.2 1.2M11.2 11.2l1.2 1.2M3.6 12.4l1.2-1.2M11.2 4.8l1.2-1.2"/></svg>';

    function sidebarRoot() {
      const column = document.querySelector('[data-pane="sidebar"], [class*="sidebarCol"]');
      if (column === null) return undefined;
      const logoOwner = column.querySelector('[class*="logoRow"]')?.parentElement;
      return logoOwner ?? (column.firstElementChild);
    }

    function newSessionButton(root) {
      const nested = root.querySelector('button[class*="newSession"]');
      if (nested !== null) return nested;
      for (const child of root.children) {
        if (child.tagName === 'BUTTON') return child;
      }
      return undefined;
    }

    function conversationColumn() {
      return document.querySelector('[data-pane="conversation"], [class*="centerCol"]') ?? undefined;
    }

    function mountChat() {
      // idempotency: never double-mount across duplicated apply / HMR.
      if (typeof document !== 'undefined' && document.querySelector('[' + ENTRY_ATTR + ']') !== null) {
        return () => {};
      }

      const style = document.createElement('style');
      style.dataset.dshChatStyle = '';
      style.textContent = CSS;
      document.head.appendChild(style);

      const entry = document.createElement('button');
      entry.type = 'button';
      entry.setAttribute(ENTRY_ATTR, '');
      entry.className = 'dsh-chat-entry';
      entry.setAttribute('aria-label', '对话');
      entry.innerHTML = '<span class="dsh-chat-entry-icon">' + ICON + '</span><span class="dsh-chat-entry-label">对话</span>';

      let root;
      let container;
      let reactRoot;
      let panelOpen = false;

      const syncEntry = () => {
        if (panelOpen) entry.setAttribute('data-active', '');
        else entry.removeAttribute('data-active');
      };

      const applyActive = () => {
        if (panelOpen) {
          for (const attr of OTHER_ACTIVE_ATTRS) document.documentElement.removeAttribute(attr);
          document.documentElement.setAttribute(ACTIVE_ATTR, '');
          document.dispatchEvent(new CustomEvent(ACTIVATE_EVENT, { detail: PANEL_NAME }));
        } else {
          document.documentElement.removeAttribute(ACTIVE_ATTR);
        }
      };

      const close = () => {
        if (!panelOpen) return;
        panelOpen = false;
        syncEntry();
        applyActive();
      };

      const ensurePanel = () => {
        if (container !== undefined) return;
        const column = conversationColumn();
        if (column === undefined) return;
        container = document.createElement('div');
        container.setAttribute(VIEW_ATTR, '');
        column.appendChild(container);
        reactRoot = createRoot(container);
        reactRoot.render(h(ChatPanel, { onClose: close }));
      };

      const toggle = () => {
        panelOpen = !panelOpen;
        syncEntry();
        applyActive();
        ensurePanel();
      };

      entry.addEventListener('click', toggle);

      const onOtherActivate = (event) => {
        if (event.detail && event.detail !== PANEL_NAME) close();
      };
      document.addEventListener(ACTIVATE_EVENT, onOtherActivate);

      // Clicking a session/workspace row hands the center column back to the
      // conversation; close the panel first (capture phase).
      const SIDEBAR_ROW_SELECTOR = '[class*="sessionRow"], [class*="projectRow"], [class*="searchResultRow"], [class*="searchResultWorkspace"], [class*="newSession"]';
      const onClickSidebarRow = (event) => {
        if (!panelOpen) return;
        const target = event.target;
        if (target && target.closest && target.closest(SIDEBAR_ROW_SELECTOR) !== null) close();
      };
      document.addEventListener('click', onClickSidebarRow, true);

      // Place / self-heal the sidebar entry.
      const placeEntry = () => {
        if (root !== undefined && !root.isConnected) {
          root = undefined;
        }
        root = root ?? sidebarRoot();
        if (root === undefined) return;
        if (entry.parentElement !== root) {
          const button = newSessionButton(root);
          if (button === undefined) return;
          const row = button.closest('[class*="logoRow"]');
          const base = (row !== null && row.parentElement === root) ? row : button;
          const family = Array.from(root.children).filter(el =>
            el instanceof HTMLElement && el.matches('[data-dsh-taskboard-entry], [data-dsh-ssh-entry]'),
          );
          const anchor = family.length > 0 ? family[0] : base.nextElementSibling;
          root.insertBefore(entry, anchor);
        }
      };

      const waitObserver = new MutationObserver(() => { placeEntry(); ensurePanel(); });
      waitObserver.observe(document.body, { childList: true, subtree: true });
      const rootObserver = new MutationObserver(() => {
        if (root === undefined || !root.isConnected) {
          placeEntry();
          return;
        }
        if (!root.contains(entry)) placeEntry();
      });

      placeEntry();
      ensurePanel();

      return () => {
        waitObserver.disconnect();
        rootObserver.disconnect();
        document.removeEventListener(ACTIVATE_EVENT, onOtherActivate);
        document.removeEventListener('click', onClickSidebarRow, true);
        document.documentElement.removeAttribute(ACTIVE_ATTR);
        if (reactRoot) { try { reactRoot.unmount(); } catch { /* noop */ } }
        if (container) { container.remove(); }
        entry.remove();
        style.remove();
      };
    }

    // ---------------------------------------------------------------------
    // Plugin surface.
    // ---------------------------------------------------------------------
    const inject = [];

    function apply(ctx) {
      ctx.effect(() => mountChat(), 'dsh-chat: ui');
    }

    exports.apply = apply;
    exports.inject = inject;
    return module.exports;
  }
});

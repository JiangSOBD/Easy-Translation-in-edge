(() => {
  if (globalThis.__linguaSelectionLoaded) return;
  globalThis.__linguaSelectionLoaded = true;

  const MAX_SELECTION_LENGTH = 3000;
  const MAX_SENTENCE_LENGTH = 6000;
  const CACHE_HIGHLIGHT_NAME = "lingua-translated-selection";
  const BLOCK_SELECTOR = "p,li,blockquote,pre,h1,h2,h3,h4,h5,h6,td,th,dd,dt,figcaption";
  const cachedSelections = new Map();
  let host;
  let root;
  let latestSelection;
  let pageContextEnabled = false;
  let pageContext = "";
  let selectionTimer;
  let pagePointerDown = false;
  let panelPosition = null;
  let dragState = null;
  const activeRequestIds = { translation: null, concept: null };
  let highlightStyle;

  function makeRequestId() {
    return globalThis.crypto?.randomUUID
      ? globalThis.crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  }

  function selectionKey(text, sentence) {
    return JSON.stringify([text, sentence]);
  }

  function sendMessage(message) {
    return new Promise((resolve, reject) => {
      chrome.runtime.sendMessage(message, (response) => {
        const error = chrome.runtime.lastError;
        if (error) {
          reject(new Error(error.message));
          return;
        }
        if (!response?.ok) {
          reject(new Error(response?.error || "操作失败，请重试。"));
          return;
        }
        resolve(response.data);
      });
    });
  }

  function getSelectionBlock(range) {
    let element = range.commonAncestorContainer.nodeType === Node.ELEMENT_NODE
      ? range.commonAncestorContainer
      : range.commonAncestorContainer.parentElement;
    if (!element) return null;
    const block = element.closest(BLOCK_SELECTOR);
    if (block && block.contains(range.startContainer) && block.contains(range.endContainer)) return block;
    const fallback = element.closest("main,article,section,div");
    if (fallback && fallback.contains(range.startContainer) && fallback.contains(range.endContainer)) {
      return fallback;
    }
    return null;
  }

  function getSelectionOffsets(block, range) {
    const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT);
    let position = 0;
    let start = -1;
    let end = -1;
    let node;
    while ((node = walker.nextNode())) {
      if (node === range.startContainer) start = position + range.startOffset;
      if (node === range.endContainer) end = position + range.endOffset;
      position += node.textContent.length;
    }
    return start >= 0 && end >= 0 ? { start, end } : null;
  }

  function findSentence(text, start, end, selectedText) {
    if (!text || text.length > 20000 || start < 0 || end < start) return selectedText;
    if (typeof Intl.Segmenter === "function") {
      const segments = new Intl.Segmenter("en", { granularity: "sentence" }).segment(text);
      for (const part of segments) {
        const partStart = part.index;
        const partEnd = partStart + part.segment.length;
        if (start >= partStart && start <= partEnd) {
          if (start <= partStart && end >= partEnd) return selectedText;
          const sentence = part.segment.trim();
          return sentence.length <= MAX_SENTENCE_LENGTH ? sentence : selectedText;
        }
      }
    }
    const boundaries = [];
    const punctuation = /[.!?。！？]+(?:["'”’)\]]*)\s+/g;
    let match;
    while ((match = punctuation.exec(text))) boundaries.push(match.index + match[0].length);
    let left = 0;
    let right = text.length;
    for (const boundary of boundaries) {
      if (boundary <= start) left = boundary;
      else if (boundary > start) {
        right = boundary;
        break;
      }
    }
    if (start <= left && end >= right) return selectedText;
    const sentence = text.slice(left, right).trim();
    return sentence.length <= MAX_SENTENCE_LENGTH ? sentence : selectedText;
  }

  function selectionDetails() {
    const selection = window.getSelection();
    if (!selection || selection.isCollapsed) return null;
    const text = selection.toString().replace(/\s+/g, " ").trim();
    if (!text || text.length > MAX_SELECTION_LENGTH) return null;
    const range = selection.getRangeAt(0);
    const rect = range.getBoundingClientRect();
    if (!rect || (!rect.width && !rect.height)) return null;
    const block = getSelectionBlock(range);
    const offsets = block && getSelectionOffsets(block, range);
    const blockText = block?.textContent || "";
    const sentence = offsets
      ? findSentence(blockText, offsets.start, offsets.end, text)
      : text;
    return {
      text,
      sentence,
      key: selectionKey(text, sentence),
      range: range.cloneRange(),
      rect: { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom }
    };
  }

  function ensureHost() {
    if (host?.isConnected) return;
    host = document.createElement("div");
    host.id = "lingua-selection-extension";
    host.style.cssText = "all:initial;position:fixed;z-index:2147483647;inset:0 auto auto 0;pointer-events:none;";
    root = host.attachShadow({ mode: "closed" });
    root.innerHTML = `
      <style>
        :host{all:initial}
        .panel{position:fixed;pointer-events:auto;min-width:230px;max-width:min(380px,calc(100vw - 24px));font:13px/1.45 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:#182230;background:#fff;border:1px solid #d9e0e9;border-radius:12px;box-shadow:0 8px 28px rgba(15,23,42,.18);overflow:hidden}
        .toolbar{display:flex;gap:6px;padding:8px}
        button{font:inherit;cursor:pointer;border:0;border-radius:8px;padding:7px 10px;background:#f1f5f9;color:#172033}
        button:hover{background:#e2e8f0}
        button.primary{background:#2457d6;color:white}
        button.primary:hover{background:#1948be}
        button.move-handle{padding:5px 8px;cursor:move;touch-action:none;user-select:none}
        button.close{margin-left:auto;padding:5px 8px;background:transparent;color:#64748b}
        .context{display:flex;align-items:center;gap:6px;padding:0 10px 8px;color:#536174;font-size:12px}
        .context input{accent-color:#2457d6}
        .result{border-top:1px solid #e7ebf0;padding:10px 12px;max-height:250px;overflow:auto;overflow-wrap:anywhere}
        .concept-result:not(:empty){margin-top:10px;padding-top:9px;border-top:1px solid #e7ebf0}
        .label{font-size:11px;color:#64748b;margin:2px 0 3px}
        .value{white-space:pre-wrap}
        .ipa{color:#536174;margin-top:5px}
        .error{color:#b42318}
        .status{color:#536174}
        .actions{display:flex;gap:6px;margin-top:9px}
        .actions button{font-size:12px}
        .hidden{display:none}
      </style>
      <section class="panel hidden" role="dialog" aria-label="划词翻译工具">
        <div class="toolbar">
          <button class="primary translate">重新翻译</button>
          <button class="explain">AI 概念解读</button>
          <button class="move-handle" type="button" aria-label="拖动移动翻译框" title="拖动移动翻译框">移动</button>
          <button class="close" aria-label="关闭">×</button>
        </div>
        <label class="context"><input type="checkbox"><span>本页背景（供概念解读）</span></label>
        <div class="result hidden" aria-live="polite">
          <div class="translation-result"></div>
          <div class="concept-result"></div>
        </div>
      </section>`;
    document.documentElement.appendChild(host);
    root.querySelector(".translate").addEventListener("click", runTranslation);
    root.querySelector(".explain").addEventListener("click", runExplanation);
    const moveHandle = root.querySelector(".move-handle");
    moveHandle.addEventListener("pointerdown", startPanelDrag);
    moveHandle.addEventListener("pointermove", movePanel);
    moveHandle.addEventListener("pointerup", endPanelDrag);
    moveHandle.addEventListener("pointercancel", endPanelDrag);
    root.querySelector(".close").addEventListener("click", hidePanel);
    root.querySelector(".context input").addEventListener("change", togglePageContext);
    root.querySelector(".result").addEventListener("click", handleResultAction);
  }

  function positionPanel(rect) {
    const panel = root.querySelector(".panel");
    if (latestSelection?.range) {
      const currentRect = latestSelection.range.getBoundingClientRect();
      if (currentRect.width || currentRect.height) {
        latestSelection.rect = {
          left: currentRect.left,
          top: currentRect.top,
          right: currentRect.right,
          bottom: currentRect.bottom
        };
        rect = latestSelection.rect;
      }
    }
    panel.classList.remove("hidden");
    const panelRect = panel.getBoundingClientRect();
    const margin = 8;
    const maxLeft = Math.max(margin, window.innerWidth - panelRect.width - margin);
    const left = panelPosition
      ? Math.max(margin, Math.min(panelPosition.left, maxLeft))
      : Math.max(margin, Math.min(rect.left, maxLeft));
    const below = rect.bottom + margin;
    const top = panelPosition
      ? Math.max(margin, Math.min(panelPosition.top, window.innerHeight - panelRect.height - margin))
      : below + panelRect.height <= window.innerHeight
        ? below
        : Math.max(margin, rect.top - panelRect.height - margin);
    panel.style.left = `${left}px`;
    panel.style.top = `${top}px`;
  }

  function startPanelDrag(event) {
    if (event.button !== 0) return;
    const panel = root.querySelector(".panel");
    const rect = panel.getBoundingClientRect();
    dragState = {
      pointerId: event.pointerId,
      offsetX: event.clientX - rect.left,
      offsetY: event.clientY - rect.top
    };
    event.currentTarget.setPointerCapture(event.pointerId);
    event.preventDefault();
  }

  function movePanel(event) {
    if (!dragState || event.pointerId !== dragState.pointerId) return;
    const panel = root.querySelector(".panel");
    const rect = panel.getBoundingClientRect();
    const left = Math.max(8, Math.min(event.clientX - dragState.offsetX, window.innerWidth - rect.width - 8));
    const top = Math.max(8, Math.min(event.clientY - dragState.offsetY, window.innerHeight - rect.height - 8));
    panelPosition = { left, top };
    panel.style.left = `${left}px`;
    panel.style.top = `${top}px`;
    event.preventDefault();
  }

  function endPanelDrag(event) {
    if (dragState?.pointerId !== event.pointerId) return;
    dragState = null;
  }

  function showPanel(details) {
    ensureHost();
    if (!root.querySelector(".panel").classList.contains("hidden") && latestSelection?.key === details.key) {
      latestSelection.range = details.range;
      latestSelection.rect = details.rect;
      const cached = cachedSelections.get(details.key);
      if (cached) {
        cached.range = details.range.cloneRange();
        refreshHighlights();
      } else if (!activeRequestIds.translation) {
        runTranslation();
      }
      positionPanel(details.rect);
      return;
    }
    cancelActiveRequest();
    panelPosition = null;
    latestSelection = details;
    const result = root.querySelector(".result");
    result.classList.add("hidden");
    result.querySelector(".translation-result").replaceChildren();
    result.querySelector(".concept-result").replaceChildren();
    positionPanel(details.rect);
    const cached = cachedSelections.get(details.key);
    if (cached) {
      cached.range = details.range.cloneRange();
      refreshHighlights();
      showCachedSelection(cached);
    } else {
      runTranslation();
    }
  }

  function ensureHighlightStyle() {
    if (highlightStyle?.isConnected) return;
    highlightStyle = document.createElement("style");
    highlightStyle.dataset.linguaSelection = "cache-highlight";
    highlightStyle.textContent = `::highlight(${CACHE_HIGHLIGHT_NAME}){text-decoration:underline;text-decoration-color:#2457d6;text-decoration-thickness:2px;text-underline-offset:3px;background-color:rgba(36,87,214,.08)}`;
    (document.head || document.documentElement).appendChild(highlightStyle);
  }

  function refreshHighlights() {
    if (!globalThis.CSS?.highlights || typeof globalThis.Highlight !== "function") return;
    const liveRanges = [];
    for (const entry of cachedSelections.values()) {
      if (!entry.range) continue;
      const rangeText = entry.range.toString().replace(/\s+/g, " ").trim();
      if (rangeText !== entry.text || !entry.range.getClientRects().length) {
        entry.range = null;
        continue;
      }
      liveRanges.push(entry.range);
    }
    if (liveRanges.length) {
      ensureHighlightStyle();
      CSS.highlights.set(CACHE_HIGHLIGHT_NAME, new Highlight(...liveRanges));
    } else {
      CSS.highlights.delete(CACHE_HIGHLIGHT_NAME);
    }
  }

  function savePageCache(details, result) {
    if (!details?.range || !details.range.toString().trim()) return;
    cachedSelections.set(details.key, {
      key: details.key,
      text: details.text,
      sentence: details.sentence,
      range: details.range.cloneRange(),
      result: { translation: result.translation, ipa: result.ipa || "" }
    });
    refreshHighlights();
  }

  function findCachedSelectionAtPoint(x, y) {
    let match = null;
    let smallestArea = Infinity;
    for (const entry of cachedSelections.values()) {
      if (!entry.range) continue;
      const rangeText = entry.range.toString().replace(/\s+/g, " ").trim();
      if (rangeText !== entry.text) {
        entry.range = null;
        continue;
      }
      for (const rect of entry.range.getClientRects()) {
        if (x < rect.left || x > rect.right || y < rect.top || y > rect.bottom) continue;
        const area = rect.width * rect.height;
        if (area < smallestArea) {
          smallestArea = area;
          match = entry;
        }
      }
    }
    return match;
  }

  function showCachedSelection(entry) {
    ensureHost();
    cancelActiveRequest();
    if (latestSelection?.key !== entry.key) panelPosition = null;
    if (!entry.range) return;
    const rect = entry.range.getBoundingClientRect();
    latestSelection = {
      key: entry.key,
      text: entry.text,
      sentence: entry.sentence,
      range: entry.range,
      rect: { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom }
    };
    positionPanel(latestSelection.rect);
    root.querySelector(".concept-result").replaceChildren();
    renderTranslation({ ...entry.result, cached: true }, entry.text);
  }

  function cancelRequest(action) {
    const requestId = activeRequestIds[action];
    if (!requestId) return;
    sendMessage({ type: "cancel-request", requestId }).catch(() => {});
    activeRequestIds[action] = null;
  }

  function cancelActiveRequest() {
    for (const action of Object.keys(activeRequestIds)) cancelRequest(action);
  }

  function hidePanel() {
    if (!root) return;
    root.querySelector(".panel").classList.add("hidden");
    latestSelection = null;
    cancelActiveRequest();
  }

  function renderStatus(action, message, isError = false) {
    const result = root.querySelector(".result");
    result.classList.remove("hidden");
    const container = result.querySelector(action === "concept" ? ".concept-result" : ".translation-result");
    container.replaceChildren();
    const status = document.createElement("div");
    status.className = isError ? "error" : "status";
    status.textContent = message;
    container.append(status);
  }

  function renderTranslation(data, text) {
    const result = root.querySelector(".result");
    result.classList.remove("hidden");
    const translationResult = result.querySelector(".translation-result");
    translationResult.replaceChildren();
    addValue(translationResult, "原文", text);
    addValue(translationResult, "中文", data.translation || "未返回译文");
    addValue(translationResult, "音标（模型生成）", data.ipa || "暂无可靠音标");
    const actions = document.createElement("div");
    actions.className = "actions";
    actions.innerHTML = '<button data-action="copy">复制</button><button data-action="email">邮件草稿</button>';
    translationResult.append(actions);
    if (data.cached) {
      const cached = document.createElement("div");
      cached.className = "label";
      cached.textContent = "来自本次会话的快速缓存";
      translationResult.append(cached);
    }
  }

  function addValue(container, label, value) {
    const title = document.createElement("div");
    title.className = "label";
    title.textContent = label;
    const content = document.createElement("div");
    content.className = label.startsWith("音标") ? "ipa" : "value";
    content.textContent = value;
    container.append(title, content);
  }

  async function runTranslation() {
    if (!latestSelection) return;
    cancelRequest("translation");
    const snapshot = latestSelection;
    const requestId = makeRequestId();
    activeRequestIds.translation = requestId;
    renderStatus("translation", "正在翻译…");
    try {
      const data = await sendMessage({
        type: "translation-request",
        requestId,
        payload: { text: snapshot.text, sentence: snapshot.sentence }
      });
      if (activeRequestIds.translation !== requestId) return;
      savePageCache(snapshot, data);
      renderTranslation(data, snapshot.text);
    } catch (error) {
      if (activeRequestIds.translation === requestId) renderStatus("translation", error.message, true);
    } finally {
      if (activeRequestIds.translation === requestId) activeRequestIds.translation = null;
    }
  }

  async function runExplanation() {
    if (!latestSelection) return;
    cancelRequest("concept");
    const snapshot = latestSelection;
    const requestId = makeRequestId();
    activeRequestIds.concept = requestId;
    renderStatus("concept", "正在整理概念…");
    try {
      const data = await sendMessage({
        type: "concept-request",
        requestId,
        payload: {
          text: snapshot.text,
          sentence: snapshot.sentence,
          pageContext: pageContextEnabled ? pageContext : ""
        }
      });
      if (activeRequestIds.concept !== requestId) return;
      const result = root.querySelector(".result");
      result.classList.remove("hidden");
      const conceptResult = result.querySelector(".concept-result");
      conceptResult.replaceChildren();
      addValue(conceptResult, "概念解读", data.explanation);
    } catch (error) {
      if (activeRequestIds.concept === requestId) renderStatus("concept", error.message, true);
    } finally {
      if (activeRequestIds.concept === requestId) activeRequestIds.concept = null;
    }
  }

  function extractPageContext() {
    const main = document.querySelector("article,main,[role='main']") || document.body;
    return (main?.innerText || main?.textContent || "")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 12000);
  }

  function togglePageContext(event) {
    pageContextEnabled = event.currentTarget.checked;
    pageContext = pageContextEnabled ? extractPageContext() : "";
  }

  async function handleResultAction(event) {
    const action = event.target?.dataset?.action;
    if (!action || !latestSelection) return;
    if (action === "copy") {
      const text = root.querySelector(".result").innerText;
      try {
        await navigator.clipboard.writeText(text);
        renderStatus("已复制结果。");
      } catch {
        renderStatus("复制失败，请检查浏览器剪贴板权限。", true);
      }
    }
    if (action === "email") {
      const body = root.querySelector(".result").innerText;
      const subject = `划词翻译：${latestSelection.text.slice(0, 80)}`;
      const source = new URL(location.href);
      source.search = "";
      source.hash = "";
      location.href = `mailto:?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(`${body}\n\n来源：${source.href}`)}`;
    }
  }

  function sameSelection(first, second) {
    return first.key === second.key
      && first.range.startContainer === second.range.startContainer
      && first.range.startOffset === second.range.startOffset
      && first.range.endContainer === second.range.endContainer
      && first.range.endOffset === second.range.endOffset;
  }

  function onSelectionChange() {
    clearTimeout(selectionTimer);
    if (pagePointerDown) return;
    const candidate = selectionDetails();
    if (!candidate) return;
    selectionTimer = setTimeout(() => {
      if (pagePointerDown) return;
      const details = selectionDetails();
      if (details && sameSelection(candidate, details)) showPanel(details);
    }, 300);
  }

  document.addEventListener("pointerdown", (event) => {
    if (host && event.composedPath().includes(host)) return;
    pagePointerDown = true;
    clearTimeout(selectionTimer);
  }, true);
  document.addEventListener("pointerup", (event) => {
    if (!pagePointerDown) return;
    pagePointerDown = false;
    onSelectionChange(event);
  }, true);
  document.addEventListener("selectionchange", onSelectionChange, true);
  document.addEventListener("keyup", onSelectionChange, true);
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") hidePanel();
  }, true);
  document.addEventListener("mousedown", (event) => {
    if (host && !host.contains(event.target) && !event.composedPath().includes(host)) hidePanel();
  }, true);
  document.addEventListener("click", (event) => {
    if (host && (host.contains(event.target) || event.composedPath().includes(host))) return;
    const cached = findCachedSelectionAtPoint(event.clientX, event.clientY);
    if (!cached) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    showCachedSelection(cached);
  }, true);
  window.addEventListener("scroll", () => {
    if (latestSelection) positionPanel(latestSelection.rect);
  }, true);
  window.addEventListener("resize", () => {
    if (latestSelection) positionPanel(latestSelection.rect);
  });
})();

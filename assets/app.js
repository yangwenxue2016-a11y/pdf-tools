const { PDFDocument, StandardFonts, rgb, degrees } = window.PDFLib;
pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';

const state = {
  mergePages: [],
  optimizeBytes: null,
  optimizeName: 'document',
  annotate: {
    bytes: null,
    name: 'annotated',
    pdfDoc: null,
    totalPages: 0,
    currentPage: 1,
    annotationsByPage: {},
    previewSizes: {},
    mode: null,
    imageDataUrl: null,
    pageNumberConfig: null,
    watermarkConfig: null,
  },
  ocrText: '',
  extractedTextCache: new Map(),
  theme: localStorage.getItem('pdf-ai-theme') || 'light',
};

const els = {
  toolNav: document.getElementById('toolNav'),
  toolPanels: [...document.querySelectorAll('.tool-panel')],
  themeToggle: document.getElementById('themeToggle'),
  toast: document.getElementById('toast'),
  loadingOverlay: document.getElementById('loadingOverlay'),
  loadingText: document.getElementById('loadingText'),
  settingsDialog: document.getElementById('settingsDialog'),
  openSettingsBtn: document.getElementById('openSettingsBtn'),
  apiBaseUrl: document.getElementById('apiBaseUrl'),
  apiKey: document.getElementById('apiKey'),
  apiModel: document.getElementById('apiModel'),
};

const uid = (() => {
  let n = 0;
  return () => `id-${Date.now()}-${++n}`;
})();

function showToast(message, type = 'info') {
  els.toast.textContent = message;
  els.toast.classList.remove('hidden');
  els.toast.style.background = type === 'error' ? 'rgba(153,27,27,.96)' : type === 'success' ? 'rgba(6,95,70,.96)' : 'rgba(16,24,40,.92)';
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => els.toast.classList.add('hidden'), 3200);
}

function setLoading(text, active = true) {
  els.loadingText.textContent = text || '处理中…';
  els.loadingOverlay.classList.toggle('hidden', !active);
}

function saveTheme(theme) {
  state.theme = theme;
  document.body.classList.toggle('dark', theme === 'dark');
  localStorage.setItem('pdf-ai-theme', theme);
}

function saveApiSettings() {
  localStorage.setItem('pdf-ai-settings', JSON.stringify({
    baseUrl: els.apiBaseUrl.value.trim(),
    apiKey: els.apiKey.value.trim(),
    model: els.apiModel.value.trim(),
  }));
}

function loadApiSettings() {
  const saved = JSON.parse(localStorage.getItem('pdf-ai-settings') || '{}');
  els.apiBaseUrl.value = saved.baseUrl || '';
  els.apiKey.value = saved.apiKey || '';
  els.apiModel.value = saved.model || '';
}

function activateTool(toolName) {
  document.querySelectorAll('.tool-nav-item').forEach((btn) => btn.classList.toggle('active', btn.dataset.tool === toolName));
  els.toolPanels.forEach((panel) => panel.classList.toggle('active', panel.id === `tool-${toolName}`));
  document.getElementById(`tool-${toolName}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function html(content) {
  const div = document.createElement('div');
  div.innerHTML = content;
  return div;
}

function escapeHtml(str = '') {
  return String(str)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function formatBytes(bytes = 0) {
  if (!bytes) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  return `${(bytes / 1024 ** index).toFixed(index === 0 ? 0 : 2)} ${units[index]}`;
}

async function readAsUint8Array(file) {
  return new Uint8Array(await file.arrayBuffer());
}

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

function dataUrlToUint8Array(dataUrl) {
  const base64 = dataUrl.split(',')[1];
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

async function renderPdfPageToDataUrl(pdfBytes, pageNumber, scale = 0.5, mimeType = 'image/jpeg', quality = 0.88) {
  const loadingTask = pdfjsLib.getDocument({ data: pdfBytes });
  const pdf = await loadingTask.promise;
  const page = await pdf.getPage(pageNumber);
  const viewport = page.getViewport({ scale });
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d', { alpha: false });
  canvas.width = viewport.width;
  canvas.height = viewport.height;
  await page.render({ canvasContext: ctx, viewport }).promise;
  return { dataUrl: canvas.toDataURL(mimeType, quality), width: viewport.width, height: viewport.height };
}

async function renderAllPagesAsImages(pdfBytes, scale = 1.3, quality = 0.82, mimeType = 'image/jpeg') {
  const pdf = await pdfjsLib.getDocument({ data: pdfBytes }).promise;
  const images = [];
  for (let i = 1; i <= pdf.numPages; i += 1) {
    const page = await pdf.getPage(i);
    const viewport = page.getViewport({ scale });
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d', { alpha: false });
    canvas.width = viewport.width;
    canvas.height = viewport.height;
    await page.render({ canvasContext: ctx, viewport }).promise;
    images.push({
      page: i,
      width: viewport.width,
      height: viewport.height,
      dataUrl: canvas.toDataURL(mimeType, quality),
    });
  }
  return images;
}

async function rebuildPdfFromImages(images, options = {}) {
  const pdfDoc = await PDFDocument.create();
  for (const image of images) {
    const bytes = dataUrlToUint8Array(image.dataUrl);
    const embedded = image.dataUrl.startsWith('data:image/png') ? await pdfDoc.embedPng(bytes) : await pdfDoc.embedJpg(bytes);
    const page = pdfDoc.addPage([image.width + (options.margin || 0) * 2, image.height + (options.margin || 0) * 2]);
    page.drawImage(embedded, {
      x: options.margin || 0,
      y: options.margin || 0,
      width: image.width,
      height: image.height,
    });
  }
  return pdfDoc.save();
}

async function extractTextFromPdf(pdfBytes) {
  const cacheKey = `${pdfBytes.byteLength}:${pdfBytes[0]}:${pdfBytes[pdfBytes.length - 1]}`;
  if (state.extractedTextCache.has(cacheKey)) return state.extractedTextCache.get(cacheKey);
  const pdf = await pdfjsLib.getDocument({ data: pdfBytes }).promise;
  const pages = [];
  for (let i = 1; i <= pdf.numPages; i += 1) {
    const page = await pdf.getPage(i);
    const textContent = await page.getTextContent();
    const strings = textContent.items.map((item) => item.str).join(' ');
    pages.push(strings.replace(/\s+/g, ' ').trim());
  }
  const joined = pages.join('\n\n');
  state.extractedTextCache.set(cacheKey, joined);
  return joined;
}

function tokenizeSentences(text) {
  return text
    .replace(/\s+/g, ' ')
    .split(/(?<=[。！？.!?])\s+/)
    .map((item) => item.trim())
    .filter((item) => item.length > 10);
}

function summarizeText(text, sentenceCount = 6) {
  const sentences = tokenizeSentences(text);
  if (!sentences.length) return '未提取到足够文本。';
  const words = text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 1);
  const stopWords = new Set(['的', '了', '和', '是', '在', '与', '及', 'to', 'of', 'the', 'a', 'an', 'and', 'for', 'in', 'on']);
  const freq = new Map();
  for (const w of words) {
    if (stopWords.has(w)) continue;
    freq.set(w, (freq.get(w) || 0) + 1);
  }
  const scored = sentences.map((sentence, index) => {
    const score = sentence
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s]/gu, ' ')
      .split(/\s+/)
      .reduce((sum, token) => sum + (freq.get(token) || 0), 0);
    return { sentence, index, score };
  });
  return scored
    .sort((a, b) => b.score - a.score)
    .slice(0, Math.min(sentenceCount, scored.length))
    .sort((a, b) => a.index - b.index)
    .map((item, idx) => `${idx + 1}. ${item.sentence}`)
    .join('\n');
}

function buildKeyPoints(text, limit = 8) {
  const words = text
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/)
    .filter((w) => w.length >= 2);
  const freq = new Map();
  for (const word of words) freq.set(word, (freq.get(word) || 0) + 1);
  return [...freq.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([word, count]) => `${word}（${count}）`)
    .join('、');
}

function setResultCard(element, title, contentHtml) {
  element.classList.remove('empty-state');
  element.innerHTML = `<div class="section-head"><h4>${escapeHtml(title)}</h4></div><div class="content">${contentHtml}</div>`;
}

async function renderPreview(element, htmlString) {
  element.classList.remove('empty-state');
  element.innerHTML = `<div class="section-head"><h4>预览</h4></div><div class="content preview-html"></div>`;
  element.querySelector('.preview-html').innerHTML = htmlString;
}

async function exportHtmlElementToPdf(element, filename = 'export.pdf') {
  const { jsPDF } = window.jspdf;
  const canvas = await html2canvas(element, { scale: 2, backgroundColor: '#ffffff' });
  const imgData = canvas.toDataURL('image/jpeg', 0.92);
  const pdf = new jsPDF({ orientation: canvas.width > canvas.height ? 'landscape' : 'portrait', unit: 'px', format: [canvas.width, canvas.height] });
  pdf.addImage(imgData, 'JPEG', 0, 0, canvas.width, canvas.height);
  pdf.save(filename);
}

function getApiSettings() {
  return JSON.parse(localStorage.getItem('pdf-ai-settings') || '{}');
}

async function translateTextWithApi(text, targetLanguage) {
  const settings = getApiSettings();
  if (!settings.baseUrl || !settings.apiKey || !settings.model) {
    throw new Error('未配置可用的翻译接口。请先打开“AI 设置”填写 OpenAI 兼容接口。');
  }
  const response = await fetch(`${settings.baseUrl.replace(/\/$/, '')}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${settings.apiKey}`,
    },
    body: JSON.stringify({
      model: settings.model,
      temperature: 0.2,
      messages: [
        { role: 'system', content: `你是专业文档翻译助手。请将内容翻译为 ${targetLanguage}，保持原意，不添加解释。` },
        { role: 'user', content: text.slice(0, 12000) },
      ],
    }),
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error?.message || '翻译接口调用失败');
  return data.choices?.[0]?.message?.content?.trim() || '';
}

function diffText(a, b) {
  const aLines = a.split(/\n+/).map((s) => s.trim()).filter(Boolean);
  const bLines = b.split(/\n+/).map((s) => s.trim()).filter(Boolean);
  const removed = aLines.filter((line) => !bLines.includes(line)).slice(0, 25);
  const added = bLines.filter((line) => !aLines.includes(line)).slice(0, 25);
  return { removed, added };
}

// --- Navigation and settings ---
saveTheme(state.theme);
loadApiSettings();

els.themeToggle.addEventListener('click', () => saveTheme(state.theme === 'dark' ? 'light' : 'dark'));
els.openSettingsBtn.addEventListener('click', () => els.settingsDialog.showModal());
document.getElementById('saveSettingsBtn').addEventListener('click', saveApiSettings);
document.querySelectorAll('[data-target-tool]').forEach((btn) => btn.addEventListener('click', () => activateTool(btn.dataset.targetTool)));
document.getElementById('demoDataBtn').addEventListener('click', () => activateTool('merge'));
els.toolNav.addEventListener('click', (event) => {
  const button = event.target.closest('.tool-nav-item');
  if (!button) return;
  activateTool(button.dataset.tool);
});

// --- Merge workspace ---
const mergeInput = document.getElementById('mergeInput');
const insertPdfInput = document.getElementById('insertPdfInput');
const mergePagesEl = document.getElementById('mergePages');
const mergeDropzone = document.getElementById('mergeDropzone');

async function addPdfFilesToMerge(files) {
  const list = [...files].filter((file) => file.type === 'application/pdf' || file.name.toLowerCase().endsWith('.pdf'));
  if (!list.length) {
    showToast('请上传 PDF 文件。', 'error');
    return;
  }
  setLoading('正在解析 PDF 页面…');
  try {
    for (const file of list) {
      const bytes = await readAsUint8Array(file);
      const sourceId = uid();
      const pdf = await pdfjsLib.getDocument({ data: bytes }).promise;
      for (let pageIndex = 1; pageIndex <= pdf.numPages; pageIndex += 1) {
        const { dataUrl } = await renderPdfPageToDataUrl(bytes, pageIndex, 0.35);
        state.mergePages.push({
          id: uid(),
          sourceId,
          sourceName: file.name,
          sourceBytes: bytes,
          pageIndex,
          rotation: 0,
          thumbUrl: dataUrl,
          selected: false,
        });
      }
    }
    renderMergePages();
    showToast('页面已加入队列。', 'success');
  } catch (error) {
    console.error(error);
    showToast(`解析失败：${error.message}`, 'error');
  } finally {
    setLoading('', false);
    mergeInput.value = '';
    insertPdfInput.value = '';
  }
}

function renderMergePages() {
  if (!state.mergePages.length) {
    mergePagesEl.className = 'page-grid empty-state';
    mergePagesEl.innerHTML = '<div><strong>暂无页面</strong><p>上传 PDF 后，这里会显示所有页面缩略图。</p></div>';
    return;
  }
  mergePagesEl.className = 'page-grid';
  mergePagesEl.innerHTML = state.mergePages.map((page, index) => `
    <article class="page-card ${page.selected ? 'selected' : ''}" data-id="${page.id}">
      <div class="thumb"><img src="${page.thumbUrl}" alt="第 ${index + 1} 页" /></div>
      <div class="page-meta">
        <strong>${index + 1}. ${escapeHtml(page.sourceName)}</strong>
        <span>原页码 ${page.pageIndex} · 旋转 ${page.rotation}°</span>
        <div class="page-actions">
          <button class="icon-btn" data-action="toggle">✓</button>
          <button class="icon-btn" data-action="left">↺</button>
          <button class="icon-btn" data-action="right">↻</button>
          <button class="icon-btn" data-action="delete">✕</button>
        </div>
      </div>
    </article>
  `).join('');
  if (!mergePagesEl._sortable) {
    mergePagesEl._sortable = new Sortable(mergePagesEl, {
      animation: 160,
      onEnd() {
        const ids = [...mergePagesEl.querySelectorAll('.page-card')].map((item) => item.dataset.id);
        state.mergePages.sort((a, b) => ids.indexOf(a.id) - ids.indexOf(b.id));
        renderMergePages();
      },
    });
  }
}

mergePagesEl.addEventListener('click', (event) => {
  const button = event.target.closest('.icon-btn');
  const card = event.target.closest('.page-card');
  if (!button || !card) return;
  const page = state.mergePages.find((item) => item.id === card.dataset.id);
  if (!page) return;
  const action = button.dataset.action;
  if (action === 'toggle') page.selected = !page.selected;
  if (action === 'left') page.rotation = (page.rotation - 90 + 360) % 360;
  if (action === 'right') page.rotation = (page.rotation + 90) % 360;
  if (action === 'delete') state.mergePages = state.mergePages.filter((item) => item.id !== page.id);
  renderMergePages();
});

mergeInput.addEventListener('change', (e) => addPdfFilesToMerge(e.target.files));
insertPdfInput.addEventListener('change', (e) => addPdfFilesToMerge(e.target.files));
document.getElementById('clearMergeBtn').addEventListener('click', () => {
  state.mergePages = [];
  renderMergePages();
});
document.getElementById('selectAllPagesBtn').addEventListener('click', () => {
  const shouldSelect = state.mergePages.some((p) => !p.selected);
  state.mergePages.forEach((page) => { page.selected = shouldSelect; });
  renderMergePages();
});
document.getElementById('deleteSelectedPagesBtn').addEventListener('click', () => {
  state.mergePages = state.mergePages.filter((item) => !item.selected);
  renderMergePages();
});

['dragenter', 'dragover'].forEach((eventName) => {
  mergeDropzone.addEventListener(eventName, (event) => {
    event.preventDefault();
    mergeDropzone.classList.add('dragover');
  });
});
['dragleave', 'drop'].forEach((eventName) => {
  mergeDropzone.addEventListener(eventName, (event) => {
    event.preventDefault();
    mergeDropzone.classList.remove('dragover');
  });
});
mergeDropzone.addEventListener('drop', (event) => addPdfFilesToMerge(event.dataTransfer.files));

document.getElementById('exportMergedBtn').addEventListener('click', async () => {
  if (!state.mergePages.length) return showToast('请先上传 PDF。', 'error');
  setLoading('正在导出合并 PDF…');
  try {
    const output = await PDFDocument.create();
    const sourceCache = new Map();
    for (const item of state.mergePages) {
      if (!sourceCache.has(item.sourceId)) sourceCache.set(item.sourceId, await PDFDocument.load(item.sourceBytes));
      const src = sourceCache.get(item.sourceId);
      const [copied] = await output.copyPages(src, [item.pageIndex - 1]);
      copied.setRotation(degrees(item.rotation));
      output.addPage(copied);
    }
    const bytes = await output.save();
    downloadBlob(new Blob([bytes], { type: 'application/pdf' }), `${document.getElementById('mergeFilename').value.trim() || 'merged-document'}.pdf`);
    showToast('合并导出完成。', 'success');
  } catch (error) {
    console.error(error);
    showToast(`导出失败：${error.message}`, 'error');
  } finally {
    setLoading('', false);
  }
});

document.getElementById('exportSplitSelectedBtn').addEventListener('click', async () => {
  const selected = state.mergePages.filter((item) => item.selected);
  if (!selected.length) return showToast('请先选择要拆分的页面。', 'error');
  setLoading('正在拆分所选页面…');
  try {
    const zip = new JSZip();
    const sourceCache = new Map();
    for (let i = 0; i < selected.length; i += 1) {
      const item = selected[i];
      if (!sourceCache.has(item.sourceId)) sourceCache.set(item.sourceId, await PDFDocument.load(item.sourceBytes));
      const src = sourceCache.get(item.sourceId);
      const out = await PDFDocument.create();
      const [copied] = await out.copyPages(src, [item.pageIndex - 1]);
      copied.setRotation(degrees(item.rotation));
      out.addPage(copied);
      zip.file(`page-${i + 1}.pdf`, await out.save());
    }
    downloadBlob(await zip.generateAsync({ type: 'blob' }), 'selected-pages.zip');
    showToast('拆分完成。', 'success');
  } catch (error) {
    console.error(error);
    showToast(`拆分失败：${error.message}`, 'error');
  } finally {
    setLoading('', false);
  }
});

document.getElementById('exportSplitAllBtn').addEventListener('click', async () => {
  if (!state.mergePages.length) return showToast('请先上传 PDF。', 'error');
  setLoading('正在拆分全部页面…');
  try {
    const zip = new JSZip();
    const sourceCache = new Map();
    for (let i = 0; i < state.mergePages.length; i += 1) {
      const item = state.mergePages[i];
      if (!sourceCache.has(item.sourceId)) sourceCache.set(item.sourceId, await PDFDocument.load(item.sourceBytes));
      const src = sourceCache.get(item.sourceId);
      const out = await PDFDocument.create();
      const [copied] = await out.copyPages(src, [item.pageIndex - 1]);
      copied.setRotation(degrees(item.rotation));
      out.addPage(copied);
      zip.file(`page-${i + 1}.pdf`, await out.save());
    }
    downloadBlob(await zip.generateAsync({ type: 'blob' }), 'all-pages.zip');
    showToast('全部拆分完成。', 'success');
  } catch (error) {
    console.error(error);
    showToast(`拆分失败：${error.message}`, 'error');
  } finally {
    setLoading('', false);
  }
});

// --- Optimize / repair ---
const optimizeInput = document.getElementById('optimizeInput');
const qualityValue = document.getElementById('qualityValue');
const scaleValue = document.getElementById('scaleValue');

document.getElementById('compressQuality').addEventListener('input', (e) => { qualityValue.textContent = e.target.value; });
document.getElementById('compressScale').addEventListener('input', (e) => { scaleValue.textContent = e.target.value; });
optimizeInput.addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  state.optimizeBytes = await readAsUint8Array(file);
  state.optimizeName = file.name.replace(/\.pdf$/i, '');
  showToast('优化文件已载入。', 'success');
});

async function requireOptimizeBytes() {
  if (!state.optimizeBytes) throw new Error('请先在“优化与修复”中上传 PDF。');
  return state.optimizeBytes;
}

document.getElementById('compressPdfBtn').addEventListener('click', async () => {
  try {
    const bytes = await requireOptimizeBytes();
    setLoading('正在压缩 PDF…');
    const quality = Number(document.getElementById('compressQuality').value);
    const scale = Number(document.getElementById('compressScale').value);
    const images = await renderAllPagesAsImages(bytes, scale, quality, 'image/jpeg');
    const out = await rebuildPdfFromImages(images);
    downloadBlob(new Blob([out], { type: 'application/pdf' }), `${state.optimizeName}-compressed.pdf`);
    showToast('压缩完成。', 'success');
  } catch (error) {
    showToast(error.message, 'error');
  } finally {
    setLoading('', false);
  }
});

document.getElementById('cropPdfBtn').addEventListener('click', async () => {
  try {
    const bytes = await requireOptimizeBytes();
    setLoading('正在裁剪 PDF…');
    const pdf = await PDFDocument.load(bytes);
    const top = Number(document.getElementById('cropTop').value) / 100;
    const right = Number(document.getElementById('cropRight').value) / 100;
    const bottom = Number(document.getElementById('cropBottom').value) / 100;
    const left = Number(document.getElementById('cropLeft').value) / 100;
    pdf.getPages().forEach((page) => {
      const { width, height } = page.getSize();
      const x = width * left;
      const y = height * bottom;
      const w = width * (1 - left - right);
      const h = height * (1 - top - bottom);
      page.setCropBox(x, y, w, h);
      page.setMediaBox(x, y, w, h);
    });
    downloadBlob(new Blob([await pdf.save()], { type: 'application/pdf' }), `${state.optimizeName}-cropped.pdf`);
    showToast('裁剪完成。', 'success');
  } catch (error) {
    console.error(error);
    showToast(error.message, 'error');
  } finally {
    setLoading('', false);
  }
});

document.getElementById('repairPdfBtn').addEventListener('click', async () => {
  try {
    const bytes = await requireOptimizeBytes();
    setLoading('正在修复 PDF…');
    const pdf = await PDFDocument.load(bytes, { ignoreEncryption: true, updateMetadata: false });
    pdf.setProducer('PDF Studio AI');
    downloadBlob(new Blob([await pdf.save()], { type: 'application/pdf' }), `${state.optimizeName}-repaired.pdf`);
    showToast('基础修复完成。', 'success');
  } catch (error) {
    console.error(error);
    showToast(`修复失败：${error.message}`, 'error');
  } finally {
    setLoading('', false);
  }
});

document.getElementById('archivePdfBtn').addEventListener('click', async () => {
  try {
    const bytes = await requireOptimizeBytes();
    setLoading('正在生成归档增强版…');
    const pdf = await PDFDocument.load(bytes, { ignoreEncryption: true });
    pdf.setTitle(`${state.optimizeName} · Archive Enhanced`);
    pdf.setSubject('Archive Enhanced Copy');
    pdf.setCreator('PDF Studio AI');
    pdf.setProducer('PDF Studio AI');
    pdf.setLanguage('zh-CN');
    downloadBlob(new Blob([await pdf.save()], { type: 'application/pdf' }), `${state.optimizeName}-archive-enhanced.pdf`);
    showToast('归档增强版已导出。', 'success');
  } catch (error) {
    console.error(error);
    showToast(`导出失败：${error.message}`, 'error');
  } finally {
    setLoading('', false);
  }
});

// --- Convert ---
const convertPreview = document.getElementById('convertPreview');

document.getElementById('pdfToJpgBtn').addEventListener('click', async () => {
  const file = document.getElementById('pdfToJpgInput').files[0];
  if (!file) return showToast('请先上传 PDF。', 'error');
  setLoading('正在转换 PDF 为 JPG…');
  try {
    const bytes = await readAsUint8Array(file);
    const images = await renderAllPagesAsImages(bytes, 1.6, 0.9, 'image/jpeg');
    const zip = new JSZip();
    images.forEach((image) => zip.file(`${file.name.replace(/\.pdf$/i, '')}-page-${image.page}.jpg`, image.dataUrl.split(',')[1], { base64: true }));
    downloadBlob(await zip.generateAsync({ type: 'blob' }), `${file.name.replace(/\.pdf$/i, '')}-jpg.zip`);
    showToast('转换完成。', 'success');
  } catch (error) {
    console.error(error);
    showToast(error.message, 'error');
  } finally {
    setLoading('', false);
  }
});

document.getElementById('imagesToPdfBtn').addEventListener('click', async () => {
  const files = [...document.getElementById('imagesToPdfInput').files];
  if (!files.length) return showToast('请先上传图片。', 'error');
  setLoading('正在生成 PDF…');
  try {
    const margin = Number(document.getElementById('imagePdfMargin').value) || 0;
    const pdf = await PDFDocument.create();
    for (const file of files) {
      const bytes = await readAsUint8Array(file);
      const isPng = /png$/i.test(file.type) || /\.png$/i.test(file.name);
      const embedded = isPng ? await pdf.embedPng(bytes) : await pdf.embedJpg(bytes);
      const dims = embedded.scale(1);
      const page = pdf.addPage([dims.width + margin * 2, dims.height + margin * 2]);
      page.drawImage(embedded, { x: margin, y: margin, width: dims.width, height: dims.height });
    }
    downloadBlob(new Blob([await pdf.save()], { type: 'application/pdf' }), 'images-to-pdf.pdf');
    showToast('PDF 已生成。', 'success');
  } catch (error) {
    console.error(error);
    showToast(error.message, 'error');
  } finally {
    setLoading('', false);
  }
});

document.getElementById('pdfToPptBtn').addEventListener('click', async () => {
  const file = document.getElementById('pdfToPptInput').files[0];
  if (!file) return showToast('请先上传 PDF。', 'error');
  setLoading('正在生成 PPTX…');
  try {
    const bytes = await readAsUint8Array(file);
    const images = await renderAllPagesAsImages(bytes, 1.5, 0.92, 'image/jpeg');
    const pptx = new PptxGenJS();
    pptx.layout = 'LAYOUT_WIDE';
    images.forEach((image) => {
      const slide = pptx.addSlide();
      slide.addImage({ data: image.dataUrl, x: 0, y: 0, w: 13.33, h: 7.5 });
    });
    await pptx.writeFile({ fileName: `${file.name.replace(/\.pdf$/i, '')}.pptx` });
    showToast('PPTX 已生成。', 'success');
  } catch (error) {
    console.error(error);
    showToast(`生成失败：${error.message}`, 'error');
  } finally {
    setLoading('', false);
  }
});

document.getElementById('pdfToWordBtn').addEventListener('click', async () => {
  const file = document.getElementById('pdfToWordInput').files[0];
  if (!file) return showToast('请先上传 PDF。', 'error');
  setLoading('正在提取文本并生成 DOCX…');
  try {
    const text = await extractTextFromPdf(await readAsUint8Array(file));
    const paragraphs = text.split(/\n+/).filter(Boolean).map((line) => new docx.Paragraph(line));
    const doc = new docx.Document({ sections: [{ children: paragraphs.length ? paragraphs : [new docx.Paragraph('未提取到可编辑文本。')] }] });
    const blob = await docx.Packer.toBlob(doc);
    downloadBlob(blob, `${file.name.replace(/\.pdf$/i, '')}.docx`);
    showToast('DOCX 已生成。', 'success');
  } catch (error) {
    console.error(error);
    showToast(error.message, 'error');
  } finally {
    setLoading('', false);
  }
});

document.getElementById('pdfToExcelBtn').addEventListener('click', async () => {
  const file = document.getElementById('pdfToExcelInput').files[0];
  if (!file) return showToast('请先上传 PDF。', 'error');
  setLoading('正在生成 XLSX…');
  try {
    const text = await extractTextFromPdf(await readAsUint8Array(file));
    const rows = [['Page', 'Content']];
    text.split(/\n\n+/).forEach((pageText, index) => rows.push([index + 1, pageText]));
    const wb = XLSX.utils.book_new();
    const ws = XLSX.utils.aoa_to_sheet(rows);
    XLSX.utils.book_append_sheet(wb, ws, 'PDF Text');
    const out = XLSX.write(wb, { type: 'array', bookType: 'xlsx' });
    downloadBlob(new Blob([out], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }), `${file.name.replace(/\.pdf$/i, '')}.xlsx`);
    showToast('XLSX 已生成。', 'success');
  } catch (error) {
    console.error(error);
    showToast(error.message, 'error');
  } finally {
    setLoading('', false);
  }
});

document.getElementById('officeToPdfBtn').addEventListener('click', async () => {
  const file = document.getElementById('officeToPdfInput').files[0];
  if (!file) return showToast('请先上传 DOCX 或 XLSX。', 'error');
  setLoading('正在渲染 Office 文档…');
  try {
    let previewHtml = '';
    if (/\.docx$/i.test(file.name)) {
      const result = await mammoth.convertToHtml({ arrayBuffer: await file.arrayBuffer() });
      previewHtml = `<article>${result.value}</article>`;
    } else if (/\.xlsx$/i.test(file.name)) {
      const workbook = XLSX.read(await file.arrayBuffer());
      previewHtml = workbook.SheetNames.map((name) => {
        const htmlString = XLSX.utils.sheet_to_html(workbook.Sheets[name]);
        return `<section><h5>${escapeHtml(name)}</h5>${htmlString}</section>`;
      }).join('');
    } else {
      throw new Error('当前仅支持 DOCX 与 XLSX 的浏览器内转换。');
    }
    await renderPreview(convertPreview, previewHtml);
    await exportHtmlElementToPdf(convertPreview.querySelector('.content'), `${file.name.replace(/\.[^.]+$/, '')}.pdf`);
    showToast('PDF 已导出。', 'success');
  } catch (error) {
    console.error(error);
    showToast(`转换失败：${error.message}`, 'error');
  } finally {
    setLoading('', false);
  }
});

document.getElementById('urlToPdfBtn').addEventListener('click', async () => {
  const url = document.getElementById('urlToPdfInput').value.trim();
  if (!url) return showToast('请输入 URL。', 'error');
  setLoading('正在抓取网页内容…');
  try {
    const response = await fetch(url);
    if (!response.ok) throw new Error('网页抓取失败，可能被目标站点阻止。');
    const htmlText = await response.text();
    const parser = new DOMParser();
    const doc = parser.parseFromString(htmlText, 'text/html');
    const title = doc.querySelector('title')?.textContent || url;
    const bodyText = doc.body?.innerText?.slice(0, 12000) || '未提取到正文。';
    await renderPreview(convertPreview, `<article><h3>${escapeHtml(title)}</h3><pre>${escapeHtml(bodyText)}</pre></article>`);
    await exportHtmlElementToPdf(convertPreview.querySelector('.content'), 'webpage-export.pdf');
    showToast('网页 PDF 已导出。', 'success');
  } catch (error) {
    console.error(error);
    showToast(`转换失败：${error.message}`, 'error');
  } finally {
    setLoading('', false);
  }
});

document.getElementById('pptToPdfBtn').addEventListener('click', () => {
  showToast('PPT/PPTX → PDF 在纯静态浏览器环境下兼容性有限。建议优先在桌面 Office 导出 PDF，或使用本页其他已实现转换流程。', 'error');
});

// --- Annotate ---
const annotateInput = document.getElementById('annotateInput');
const editorStage = document.getElementById('editorStage');
const annotatePageLabel = document.getElementById('annotatePageLabel');

annotateInput.addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  setLoading('正在加载编辑画布…');
  try {
    state.annotate.bytes = await readAsUint8Array(file);
    state.annotate.name = file.name.replace(/\.pdf$/i, '');
    state.annotate.pdfDoc = await pdfjsLib.getDocument({ data: state.annotate.bytes }).promise;
    state.annotate.totalPages = state.annotate.pdfDoc.numPages;
    state.annotate.currentPage = 1;
    state.annotate.annotationsByPage = {};
    state.annotate.previewSizes = {};
    state.annotate.pageNumberConfig = null;
    state.annotate.watermarkConfig = null;
    await renderAnnotatePage();
    showToast('编辑文档已载入。', 'success');
  } catch (error) {
    console.error(error);
    showToast(error.message, 'error');
  } finally {
    setLoading('', false);
  }
});

async function renderAnnotatePage() {
  if (!state.annotate.pdfDoc) {
    editorStage.className = 'editor-stage empty-state';
    editorStage.innerHTML = '<div><strong>暂无文档</strong><p>上传 PDF 后，可直接在页面上点击放置文本、图片和矩形标注。</p></div>';
    annotatePageLabel.textContent = '第 0 / 0 页';
    return;
  }
  const pageNumber = state.annotate.currentPage;
  annotatePageLabel.textContent = `第 ${pageNumber} / ${state.annotate.totalPages} 页`;
  const page = await state.annotate.pdfDoc.getPage(pageNumber);
  const viewport = page.getViewport({ scale: 1.2 });
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d', { alpha: false });
  canvas.width = viewport.width;
  canvas.height = viewport.height;
  await page.render({ canvasContext: ctx, viewport }).promise;
  state.annotate.previewSizes[pageNumber] = { width: canvas.width, height: canvas.height };
  editorStage.className = 'editor-stage';
  editorStage.innerHTML = '';
  const artboard = html(`<div class="editor-artboard"><canvas></canvas><div class="annotation-layer"></div></div>`);
  artboard.querySelector('canvas').replaceWith(canvas);
  editorStage.appendChild(artboard);
  renderAnnotationLayer();
}

function renderAnnotationLayer() {
  const layer = editorStage.querySelector('.annotation-layer');
  if (!layer) return;
  const pageNumber = state.annotate.currentPage;
  const items = state.annotate.annotationsByPage[pageNumber] || [];
  layer.innerHTML = items.map((item) => {
    if (item.type === 'text') {
      return `<div class="annotation-item text" data-id="${item.id}" style="left:${item.x}px;top:${item.y}px;color:${item.color};font-size:${item.fontSize}px;">${escapeHtml(item.text)}</div>`;
    }
    if (item.type === 'rect') {
      return `<div class="annotation-item rect" data-id="${item.id}" style="left:${item.x}px;top:${item.y}px;width:${item.w}px;height:${item.h}px;color:${item.color};"></div>`;
    }
    return `<div class="annotation-item image" data-id="${item.id}" style="left:${item.x}px;top:${item.y}px;"><img src="${item.dataUrl}" alt="annotation" /></div>`;
  }).join('');
}

function addAnnotationOnCurrentPage(item) {
  const pageNumber = state.annotate.currentPage;
  state.annotate.annotationsByPage[pageNumber] = state.annotate.annotationsByPage[pageNumber] || [];
  state.annotate.annotationsByPage[pageNumber].push({ id: uid(), ...item });
  renderAnnotationLayer();
}

document.getElementById('annotationImageInput').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  state.annotate.imageDataUrl = await new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.readAsDataURL(file);
  });
});

document.getElementById('addTextAnnotationBtn').addEventListener('click', () => {
  state.annotate.mode = 'text';
  showToast('请在页面上点击放置文本。');
});
document.getElementById('addRectAnnotationBtn').addEventListener('click', () => {
  state.annotate.mode = 'rect';
  showToast('请在页面上点击放置矩形。');
});
document.getElementById('addImageAnnotationBtn').addEventListener('click', () => {
  if (!state.annotate.imageDataUrl) return showToast('请先上传签名或图片。', 'error');
  state.annotate.mode = 'image';
  showToast('请在页面上点击放置图片。');
});

editorStage.addEventListener('click', (event) => {
  if (!state.annotate.mode) return;
  const artboard = editorStage.querySelector('.editor-artboard');
  if (!artboard) return;
  const rect = artboard.getBoundingClientRect();
  const x = event.clientX - rect.left;
  const y = event.clientY - rect.top;
  const color = document.getElementById('annotationColor').value;
  const fontSize = Number(document.getElementById('annotationFontSize').value) || 18;
  if (state.annotate.mode === 'text') {
    addAnnotationOnCurrentPage({ type: 'text', text: document.getElementById('annotationText').value || '文本', x, y, color, fontSize });
  } else if (state.annotate.mode === 'rect') {
    addAnnotationOnCurrentPage({ type: 'rect', x, y, w: 140, h: 54, color });
  } else if (state.annotate.mode === 'image') {
    addAnnotationOnCurrentPage({ type: 'image', x, y, dataUrl: state.annotate.imageDataUrl });
  }
  state.annotate.mode = null;
});

editorStage.addEventListener('dblclick', (event) => {
  const item = event.target.closest('.annotation-item');
  if (!item) return;
  const pageNumber = state.annotate.currentPage;
  state.annotate.annotationsByPage[pageNumber] = (state.annotate.annotationsByPage[pageNumber] || []).filter((entry) => entry.id !== item.dataset.id);
  renderAnnotationLayer();
  showToast('已删除标注。');
});

document.getElementById('prevAnnotatePageBtn').addEventListener('click', async () => {
  if (!state.annotate.pdfDoc || state.annotate.currentPage <= 1) return;
  state.annotate.currentPage -= 1;
  await renderAnnotatePage();
});
document.getElementById('nextAnnotatePageBtn').addEventListener('click', async () => {
  if (!state.annotate.pdfDoc || state.annotate.currentPage >= state.annotate.totalPages) return;
  state.annotate.currentPage += 1;
  await renderAnnotatePage();
});
document.getElementById('applyPageNumbersBtn').addEventListener('click', () => {
  state.annotate.pageNumberConfig = {
    start: Number(document.getElementById('pageNumberStart').value) || 1,
    position: document.getElementById('pageNumberPosition').value,
  };
  showToast('页码设置已加入导出任务。', 'success');
});
document.getElementById('applyWatermarkBtn').addEventListener('click', () => {
  state.annotate.watermarkConfig = {
    text: document.getElementById('watermarkText').value || 'CONFIDENTIAL',
    opacity: Number(document.getElementById('watermarkOpacity').value) || 0.18,
  };
  showToast('水印设置已加入导出任务。', 'success');
});

document.getElementById('exportAnnotatedBtn').addEventListener('click', async () => {
  if (!state.annotate.bytes) return showToast('请先上传 PDF。', 'error');
  setLoading('正在导出编辑后的 PDF…');
  try {
    const pdf = await PDFDocument.load(state.annotate.bytes);
    const font = await pdf.embedFont(StandardFonts.Helvetica);
    for (let pageIndex = 0; pageIndex < pdf.getPageCount(); pageIndex += 1) {
      const pageNum = pageIndex + 1;
      const page = pdf.getPage(pageIndex);
      const { width, height } = page.getSize();
      const preview = state.annotate.previewSizes[pageNum] || { width, height };
      const xScale = width / preview.width;
      const yScale = height / preview.height;
      const items = state.annotate.annotationsByPage[pageNum] || [];
      for (const item of items) {
        if (item.type === 'text') {
          page.drawText(item.text, {
            x: item.x * xScale,
            y: height - item.y * yScale - item.fontSize * yScale,
            size: item.fontSize * xScale,
            font,
            color: hexToRgb(item.color),
          });
        }
        if (item.type === 'rect') {
          page.drawRectangle({
            x: item.x * xScale,
            y: height - (item.y + item.h) * yScale,
            width: item.w * xScale,
            height: item.h * yScale,
            borderWidth: 2,
            borderColor: hexToRgb(item.color),
          });
        }
        if (item.type === 'image') {
          const bytes = dataUrlToUint8Array(item.dataUrl);
          const isPng = item.dataUrl.startsWith('data:image/png');
          const embedded = isPng ? await pdf.embedPng(bytes) : await pdf.embedJpg(bytes);
          page.drawImage(embedded, {
            x: item.x * xScale,
            y: height - (item.y + 80) * yScale,
            width: 120 * xScale,
            height: 80 * yScale,
          });
        }
      }
      if (state.annotate.pageNumberConfig) {
        drawPageNumber(page, pageNum, state.annotate.pageNumberConfig, font);
      }
      if (state.annotate.watermarkConfig) {
        drawWatermark(page, state.annotate.watermarkConfig, font);
      }
    }
    downloadBlob(new Blob([await pdf.save()], { type: 'application/pdf' }), `${state.annotate.name}-edited.pdf`);
    showToast('编辑版 PDF 已导出。', 'success');
  } catch (error) {
    console.error(error);
    showToast(`导出失败：${error.message}`, 'error');
  } finally {
    setLoading('', false);
  }
});

function hexToRgb(hex) {
  const clean = hex.replace('#', '');
  const bigint = Number.parseInt(clean, 16);
  return rgb(((bigint >> 16) & 255) / 255, ((bigint >> 8) & 255) / 255, (bigint & 255) / 255);
}

function drawPageNumber(page, pageNum, config, font) {
  const { width, height } = page.getSize();
  const text = String((config.start || 1) + pageNum - 1);
  let x = width - 48;
  let y = 20;
  if (config.position === 'bottom-center') x = width / 2 - 8;
  if (config.position === 'top-right') { x = width - 48; y = height - 24; }
  if (config.position === 'top-center') { x = width / 2 - 8; y = height - 24; }
  page.drawText(text, { x, y, size: 12, font, color: rgb(0.35, 0.35, 0.35) });
}

function drawWatermark(page, config, font) {
  const { width, height } = page.getSize();
  page.drawText(config.text, {
    x: width / 2 - 130,
    y: height / 2,
    size: 36,
    font,
    color: rgb(0.5, 0.5, 0.5),
    opacity: config.opacity,
    rotate: degrees(35),
  });
}

// --- Security ---
async function encryptPdfBytes(bytes, userPassword, ownerPassword) {
  if (window.PDFLibPlusEncrypt?.PDFDocument) {
    const doc = await window.PDFLibPlusEncrypt.PDFDocument.load(bytes);
    doc.encrypt({
      userPassword,
      ownerPassword: ownerPassword || userPassword,
      permissions: { copying: false, modifying: false, printing: 'highResolution' },
    });
    return doc.save();
  }
  const doc = await PDFDocument.load(bytes);
  if (typeof doc.encrypt === 'function') {
    doc.encrypt({
      userPassword,
      ownerPassword: ownerPassword || userPassword,
      permissions: { copying: false, modifying: false, printing: 'highResolution' },
    });
    return doc.save();
  }
  throw new Error('当前浏览器未成功加载加密扩展库。');
}

document.getElementById('encryptPdfBtn').addEventListener('click', async () => {
  const file = document.getElementById('encryptPdfInput').files[0];
  const userPassword = document.getElementById('encryptUserPassword').value;
  const ownerPassword = document.getElementById('encryptOwnerPassword').value;
  if (!file || !userPassword) return showToast('请上传 PDF 并输入密码。', 'error');
  setLoading('正在加密 PDF…');
  try {
    const out = await encryptPdfBytes(await readAsUint8Array(file), userPassword, ownerPassword);
    downloadBlob(new Blob([out], { type: 'application/pdf' }), `${file.name.replace(/\.pdf$/i, '')}-secured.pdf`);
    showToast('PDF 已加密。', 'success');
  } catch (error) {
    console.error(error);
    showToast(`加密失败：${error.message}`, 'error');
  } finally {
    setLoading('', false);
  }
});

document.getElementById('unlockPdfBtn').addEventListener('click', async () => {
  const file = document.getElementById('unlockPdfInput').files[0];
  const password = document.getElementById('unlockPdfPassword').value;
  if (!file || !password) return showToast('请上传 PDF 并输入已知密码。', 'error');
  setLoading('正在尝试解锁 PDF…');
  try {
    const bytes = await readAsUint8Array(file);
    const pdf = await pdfjsLib.getDocument({ data: bytes, password }).promise;
    const images = [];
    for (let i = 1; i <= pdf.numPages; i += 1) {
      const page = await pdf.getPage(i);
      const viewport = page.getViewport({ scale: 1.6 });
      const canvas = document.createElement('canvas');
      const ctx = canvas.getContext('2d', { alpha: false });
      canvas.width = viewport.width;
      canvas.height = viewport.height;
      await page.render({ canvasContext: ctx, viewport }).promise;
      images.push({ page: i, width: viewport.width, height: viewport.height, dataUrl: canvas.toDataURL('image/jpeg', 0.94) });
    }
    const out = await rebuildPdfFromImages(images);
    downloadBlob(new Blob([out], { type: 'application/pdf' }), `${file.name.replace(/\.pdf$/i, '')}-unlocked.pdf`);
    showToast('解锁副本已生成。', 'success');
  } catch (error) {
    console.error(error);
    showToast(`解锁失败：${error.message}`, 'error');
  } finally {
    setLoading('', false);
  }
});

document.getElementById('redactPdfBtn').addEventListener('click', async () => {
  const file = document.getElementById('redactPdfInput').files[0];
  const keywords = document.getElementById('redactKeywords').value.split(',').map((s) => s.trim()).filter(Boolean);
  if (!file || !keywords.length) return showToast('请上传 PDF 并输入关键词。', 'error');
  setLoading('正在生成密文版 PDF…');
  try {
    const bytes = await readAsUint8Array(file);
    const pdf = await pdfjsLib.getDocument({ data: bytes }).promise;
    const images = [];
    for (let i = 1; i <= pdf.numPages; i += 1) {
      const page = await pdf.getPage(i);
      const viewport = page.getViewport({ scale: 1.5 });
      const canvas = document.createElement('canvas');
      const ctx = canvas.getContext('2d', { alpha: false });
      canvas.width = viewport.width;
      canvas.height = viewport.height;
      await page.render({ canvasContext: ctx, viewport }).promise;
      const textContent = await page.getTextContent();
      ctx.fillStyle = '#000';
      textContent.items.forEach((item) => {
        const match = keywords.some((keyword) => item.str.includes(keyword));
        if (!match) return;
        const [a, b, c, d, e, f] = item.transform;
        const itemX = e * 1.5;
        const itemY = canvas.height - f * 1.5;
        const width = item.width * 1.5;
        const height = Math.abs(d) * 1.6 || 14;
        ctx.fillRect(itemX, itemY - height, width, height + 3);
      });
      images.push({ page: i, width: canvas.width, height: canvas.height, dataUrl: canvas.toDataURL('image/jpeg', 0.96) });
    }
    const out = await rebuildPdfFromImages(images);
    downloadBlob(new Blob([out], { type: 'application/pdf' }), `${file.name.replace(/\.pdf$/i, '')}-redacted.pdf`);
    showToast('密文版已生成。', 'success');
  } catch (error) {
    console.error(error);
    showToast(`生成失败：${error.message}`, 'error');
  } finally {
    setLoading('', false);
  }
});

document.getElementById('signPdfBtn').addEventListener('click', async () => {
  const pdfFile = document.getElementById('signPdfInput').files[0];
  const imageFile = document.getElementById('signImageInput').files[0];
  const pageNumber = Number(document.getElementById('signPageNumber').value) || 1;
  if (!pdfFile || !imageFile) return showToast('请上传 PDF 和签名图片。', 'error');
  setLoading('正在添加签名…');
  try {
    const pdf = await PDFDocument.load(await readAsUint8Array(pdfFile));
    const imageData = await new Promise((resolve) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.readAsDataURL(imageFile);
    });
    const bytes = dataUrlToUint8Array(imageData);
    const isPng = imageData.startsWith('data:image/png');
    const embed = isPng ? await pdf.embedPng(bytes) : await pdf.embedJpg(bytes);
    const page = pdf.getPage(Math.min(Math.max(pageNumber - 1, 0), pdf.getPageCount() - 1));
    const { width } = page.getSize();
    page.drawImage(embed, { x: width - 180, y: 36, width: 130, height: 56 });
    downloadBlob(new Blob([await pdf.save()], { type: 'application/pdf' }), `${pdfFile.name.replace(/\.pdf$/i, '')}-signed.pdf`);
    showToast('签名已添加。', 'success');
  } catch (error) {
    console.error(error);
    showToast(`签名失败：${error.message}`, 'error');
  } finally {
    setLoading('', false);
  }
});

document.getElementById('generateSignRequestBtn').addEventListener('click', async () => {
  setLoading('正在生成签署请求封面…');
  try {
    const name = document.getElementById('signRequestName').value.trim() || '待签署人';
    const pdf = await PDFDocument.create();
    const page = pdf.addPage([595, 842]);
    const font = await pdf.embedFont(StandardFonts.Helvetica);
    page.drawText('签署请求封面', { x: 60, y: 760, size: 28, font, color: rgb(0.12, 0.18, 0.35) });
    page.drawText(`签署对象：${name}`, { x: 60, y: 700, size: 18, font });
    page.drawText('说明：请将本封面页与待签文件一并发送至第三方签署平台或邮件流程。', { x: 60, y: 660, size: 14, font });
    downloadBlob(new Blob([await pdf.save()], { type: 'application/pdf' }), 'sign-request-cover.pdf');
    showToast('签署请求封面已生成。', 'success');
  } catch (error) {
    console.error(error);
    showToast(error.message, 'error');
  } finally {
    setLoading('', false);
  }
});

// --- OCR and utilities ---
const ocrResultEl = document.getElementById('ocrResult');
const compareResultEl = document.getElementById('compareResult');

async function runOcrOnCanvas(canvas, lang) {
  const result = await Tesseract.recognize(canvas, lang);
  return result.data.text || '';
}

document.getElementById('runOcrBtn').addEventListener('click', async () => {
  const file = document.getElementById('ocrPdfInput').files[0];
  const lang = document.getElementById('ocrLanguage').value;
  if (!file) return showToast('请先上传 PDF 或图片。', 'error');
  setLoading('正在执行 OCR，长文档可能需要一些时间…');
  try {
    let text = '';
    if (file.type.startsWith('image/')) {
      const img = new Image();
      const dataUrl = await new Promise((resolve) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.readAsDataURL(file);
      });
      await new Promise((resolve) => { img.onload = resolve; img.src = dataUrl; });
      const canvas = document.createElement('canvas');
      canvas.width = img.width;
      canvas.height = img.height;
      canvas.getContext('2d').drawImage(img, 0, 0);
      text = await runOcrOnCanvas(canvas, lang);
    } else {
      const pdf = await pdfjsLib.getDocument({ data: await readAsUint8Array(file) }).promise;
      for (let i = 1; i <= pdf.numPages; i += 1) {
        const page = await pdf.getPage(i);
        const viewport = page.getViewport({ scale: 2 });
        const canvas = document.createElement('canvas');
        canvas.width = viewport.width;
        canvas.height = viewport.height;
        await page.render({ canvasContext: canvas.getContext('2d'), viewport }).promise;
        text += `\n\n--- 第 ${i} 页 ---\n`;
        text += await runOcrOnCanvas(canvas, lang);
      }
    }
    state.ocrText = text.trim();
    setResultCard(ocrResultEl, 'OCR 结果', `<pre>${escapeHtml(state.ocrText || '未识别到文本。')}</pre>`);
    showToast('OCR 完成。', 'success');
  } catch (error) {
    console.error(error);
    showToast(`OCR 失败：${error.message}`, 'error');
  } finally {
    setLoading('', false);
  }
});

document.getElementById('scanToPdfBtn').addEventListener('click', async () => {
  const files = [...document.getElementById('scanToPdfInput').files];
  if (!files.length) return showToast('请先拍摄或选择图片。', 'error');
  setLoading('正在生成扫描 PDF…');
  try {
    const pdf = await PDFDocument.create();
    for (const file of files) {
      const bytes = await readAsUint8Array(file);
      const isPng = file.type.includes('png') || file.name.toLowerCase().endsWith('.png');
      const embedded = isPng ? await pdf.embedPng(bytes) : await pdf.embedJpg(bytes);
      const dims = embedded.scale(1);
      const page = pdf.addPage([dims.width, dims.height]);
      page.drawImage(embedded, { x: 0, y: 0, width: dims.width, height: dims.height });
    }
    downloadBlob(new Blob([await pdf.save()], { type: 'application/pdf' }), 'scanned-document.pdf');
    showToast('扫描 PDF 已生成。', 'success');
  } catch (error) {
    console.error(error);
    showToast(error.message, 'error');
  } finally {
    setLoading('', false);
  }
});

document.getElementById('comparePdfBtn').addEventListener('click', async () => {
  const fileA = document.getElementById('comparePdfA').files[0];
  const fileB = document.getElementById('comparePdfB').files[0];
  if (!fileA || !fileB) return showToast('请同时上传两份 PDF。', 'error');
  setLoading('正在比较两份 PDF…');
  try {
    const [textA, textB] = await Promise.all([
      extractTextFromPdf(await readAsUint8Array(fileA)),
      extractTextFromPdf(await readAsUint8Array(fileB)),
    ]);
    const diff = diffText(textA, textB);
    const summary = `
      <div class="kv-grid">
        <div class="kv-row"><span>新增差异条目</span><strong>${diff.added.length}</strong></div>
        <div class="kv-row"><span>删除差异条目</span><strong>${diff.removed.length}</strong></div>
      </div>
      <h5>新增内容</h5>
      <ul>${diff.added.map((item) => `<li>${escapeHtml(item)}</li>`).join('') || '<li>无</li>'}</ul>
      <h5>删除内容</h5>
      <ul>${diff.removed.map((item) => `<li>${escapeHtml(item)}</li>`).join('') || '<li>无</li>'}</ul>
    `;
    setResultCard(compareResultEl, '对比结果', summary);
    showToast('对比完成。', 'success');
  } catch (error) {
    console.error(error);
    showToast(`对比失败：${error.message}`, 'error');
  } finally {
    setLoading('', false);
  }
});

// --- AI summary / translation ---
const summaryResultEl = document.getElementById('summaryResult');
const translationResultEl = document.getElementById('translationResult');

async function getTextFromFileInput(file) {
  if (!file) throw new Error('请先上传文件。');
  if (/\.txt$/i.test(file.name) || file.type === 'text/plain') return file.text();
  if (/\.pdf$/i.test(file.name) || file.type === 'application/pdf') return extractTextFromPdf(await readAsUint8Array(file));
  throw new Error('当前仅支持 PDF 或 TXT 文本处理。');
}

document.getElementById('reuseOcrTextBtn').addEventListener('click', () => {
  if (!state.ocrText) return showToast('当前没有 OCR 结果可复用。', 'error');
  setResultCard(summaryResultEl, 'OCR 文本已复用', `<pre>${escapeHtml(state.ocrText.slice(0, 5000))}</pre>`);
  showToast('已将 OCR 文本送入 AI 工作区。', 'success');
});

document.getElementById('generateSummaryBtn').addEventListener('click', async () => {
  const file = document.getElementById('summaryPdfInput').files[0];
  const sentenceCount = Number(document.getElementById('summarySentences').value) || 6;
  setLoading('正在生成摘要…');
  try {
    const text = file ? await getTextFromFileInput(file) : state.ocrText;
    if (!text) throw new Error('没有可供摘要的文本。');
    const summary = summarizeText(text, sentenceCount);
    const tags = buildKeyPoints(text, 10);
    setResultCard(summaryResultEl, '摘要结果', `<h5>核心要点</h5><pre>${escapeHtml(summary)}</pre><h5>高频主题</h5><p>${escapeHtml(tags)}</p>`);
    showToast('摘要已生成。', 'success');
  } catch (error) {
    console.error(error);
    showToast(`摘要失败：${error.message}`, 'error');
  } finally {
    setLoading('', false);
  }
});

document.getElementById('translatePdfBtn').addEventListener('click', async () => {
  const file = document.getElementById('translatePdfInput').files[0];
  const targetLanguage = document.getElementById('translateTargetLanguage').value;
  setLoading('正在执行翻译…');
  try {
    const text = file ? await getTextFromFileInput(file) : state.ocrText;
    if (!text) throw new Error('没有可供翻译的文本。');
    const translated = await translateTextWithApi(text, targetLanguage);
    setResultCard(translationResultEl, '翻译结果', `<pre>${escapeHtml(translated || '未返回翻译内容。')}</pre>`);
    showToast('翻译完成。', 'success');
  } catch (error) {
    console.error(error);
    setResultCard(translationResultEl, '翻译状态', `<p>${escapeHtml(error.message)}</p><p>提示：此静态站翻译功能需要浏览器原生 AI 能力或你在“AI 设置”中填入 OpenAI 兼容接口。</p>`);
    showToast(`翻译失败：${error.message}`, 'error');
  } finally {
    setLoading('', false);
  }
});

// --- Initial UI state ---
renderMergePages();
renderAnnotatePage();

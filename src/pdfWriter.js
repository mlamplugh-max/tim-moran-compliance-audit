// Minimal, dependency-free PDF writer using only the 14 standard PDF fonts
// (Helvetica / Helvetica-Bold) -- no font embedding, no images, no custom
// font loading, no headless-browser dependency. This is what keeps the
// daily compliance report small: there's no subsetted TrueType font data
// baked into the file the way Chromium's page.pdf() used to add (that's
// what pushed the old report.pdf to ~78KB and made it too big for the
// cloud agent to hand-transcribe as base64 reliably -- see render-report.js
// for the full story). It also means render-report.js no longer needs to
// launch a browser at all -- one less thing that can crash the pipeline in
// the sandbox.

const fs = require('fs');

// Helvetica (regular) AFM character widths, 1/1000 em, for codes 32-126.
// Used to word-wrap both Helvetica and Helvetica-Bold text -- bold glyphs
// run a few percent wider than regular, so bold measurements below add a
// small safety margin rather than keeping a second width table.
const HELVETICA_WIDTHS = {
  32: 278, 33: 278, 34: 355, 35: 556, 36: 556, 37: 889, 38: 667, 39: 191,
  40: 333, 41: 333, 42: 389, 43: 584, 44: 278, 45: 333, 46: 278, 47: 278,
  48: 556, 49: 556, 50: 556, 51: 556, 52: 556, 53: 556, 54: 556, 55: 556,
  56: 556, 57: 556, 58: 278, 59: 278, 60: 584, 61: 584, 62: 584, 63: 556,
  64: 1015, 65: 667, 66: 667, 67: 722, 68: 722, 69: 667, 70: 611, 71: 778,
  72: 722, 73: 278, 74: 500, 75: 667, 76: 556, 77: 833, 78: 722, 79: 778,
  80: 667, 81: 778, 82: 722, 83: 667, 84: 611, 85: 722, 86: 667, 87: 944,
  88: 667, 89: 667, 90: 611, 91: 278, 92: 278, 93: 278, 94: 469, 95: 556,
  96: 333, 97: 556, 98: 556, 99: 500, 100: 556, 101: 556, 102: 278,
  103: 556, 104: 556, 105: 222, 106: 222, 107: 500, 108: 222, 109: 833,
  110: 556, 111: 556, 112: 556, 113: 556, 114: 333, 115: 500, 116: 278,
  117: 556, 118: 500, 119: 722, 120: 500, 121: 500, 122: 500, 123: 334,
  124: 260, 125: 334, 126: 584,
};

function textWidthPt(str, fontSize, bold) {
  let units = 0;
  for (let i = 0; i < str.length; i++) {
    units += HELVETICA_WIDTHS[str.charCodeAt(i)] || 556;
  }
  const pts = (units / 1000) * fontSize;
  return bold ? pts * 1.04 : pts;
}

// Strips/replaces characters outside the base14 fonts' WinAnsi glyph set so
// nothing renders as a missing-glyph box. Loses a few typographic niceties
// (curly quotes, em dashes) in the PDF only -- findings.json keeps the
// original text untouched.
function sanitizeForPdf(str) {
  return String(str == null ? '' : str)
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[–—]/g, '-')
    .replace(/…/g, '...')
    .replace(/[^\x20-\x7e]/g, '');
}

function escapePdfString(str) {
  return str.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
}

function wrapText(str, fontSize, bold, maxWidth) {
  const words = sanitizeForPdf(str).split(/\s+/).filter(Boolean);
  const lines = [];
  let current = '';
  for (const word of words) {
    const candidate = current ? `${current} ${word}` : word;
    if (current && textWidthPt(candidate, fontSize, bold) > maxWidth) {
      lines.push(current);
      current = word;
    } else {
      current = candidate;
    }
  }
  if (current) lines.push(current);
  return lines.length ? lines : [''];
}

// Condenses a full-sentence finding into a short phrase for the memo --
// first sentence (or clause before " -- "), capped at maxLen. Full text
// always stays in findings.json; this is PDF-only.
function condense(str, maxLen = 130) {
  const clean = sanitizeForPdf(str).trim();
  if (clean.length <= maxLen) return clean;
  const cut = clean.slice(0, maxLen);
  const lastSentence = cut.match(/^[\s\S]*?[.!?](?=\s|$)/);
  if (lastSentence && lastSentence[0].length > 20) return lastSentence[0].trim();
  const lastSpace = cut.lastIndexOf(' ');
  return `${cut.slice(0, lastSpace > 40 ? lastSpace : maxLen)}...`;
}

const PAGE_WIDTH = 612; // US Letter, points
const PAGE_HEIGHT = 792;
const MARGIN = 44;
const CONTENT_WIDTH = PAGE_WIDTH - MARGIN * 2;

class PdfDoc {
  constructor() {
    this.pages = [];
    this._newPage();
  }

  _newPage() {
    this.page = { textOps: [], lineOps: [], y: PAGE_HEIGHT - MARGIN };
    this.pages.push(this.page);
  }

  _ensureSpace(neededHeight) {
    if (this.page.y - neededHeight < MARGIN) {
      this._newPage();
    }
  }

  text(str, { size = 9, bold = false, color = [0.1, 0.13, 0.19], gap = 3, indent = 0 } = {}) {
    const maxWidth = CONTENT_WIDTH - indent;
    const lines = wrapText(str, size, bold, maxWidth);
    const lineHeight = size * 1.32;
    for (const line of lines) {
      this._ensureSpace(lineHeight);
      this.page.textOps.push({ font: bold ? 'F2' : 'F1', size, color, x: MARGIN + indent, y: this.page.y, str: line });
      this.page.y -= lineHeight;
    }
    this.page.y -= gap;
  }

  // A single label:value row -- bold label in a fixed-width left column,
  // regular-weight value wrapping in the remaining width. `statusColor`
  // tints the label (used for GOOD/REVIEW/GAP/UNVERIFIED status words).
  row(label, value, { labelWidth = 118, size = 8.3, statusColor = [0.07, 0.2, 0.36], gap = 4 } = {}) {
    const lineHeight = size * 1.32;
    const valueLines = wrapText(value, size, false, CONTENT_WIDTH - labelWidth);
    const rowHeight = valueLines.length * lineHeight;
    this._ensureSpace(rowHeight);

    const topY = this.page.y;
    this.page.textOps.push({ font: 'F2', size, color: statusColor, x: MARGIN, y: topY, str: sanitizeForPdf(label) });

    let y = topY;
    for (const line of valueLines) {
      this.page.textOps.push({ font: 'F1', size, color: [0.27, 0.3, 0.35], x: MARGIN + labelWidth, y, str: line });
      y -= lineHeight;
    }

    this.page.y = topY - rowHeight - gap;
  }

  hr({ gap = 7 } = {}) {
    this._ensureSpace(gap + 1);
    this.page.lineOps.push({ x1: MARGIN, y1: this.page.y, x2: PAGE_WIDTH - MARGIN, y2: this.page.y });
    this.page.y -= gap;
  }

  spacer(amount) {
    this._ensureSpace(amount);
    this.page.y -= amount;
  }

  _renderPageStream(page) {
    let out = '';
    if (page.textOps.length) {
      out += 'BT\n';
      let curFont = null;
      let curSize = null;
      let curColor = null;
      for (const op of page.textOps) {
        if (op.font !== curFont || op.size !== curSize) {
          out += `/${op.font} ${op.size} Tf\n`;
          curFont = op.font;
          curSize = op.size;
        }
        if (!curColor || op.color[0] !== curColor[0] || op.color[1] !== curColor[1] || op.color[2] !== curColor[2]) {
          out += `${op.color[0].toFixed(3)} ${op.color[1].toFixed(3)} ${op.color[2].toFixed(3)} rg\n`;
          curColor = op.color;
        }
        out += `1 0 0 1 ${op.x.toFixed(2)} ${op.y.toFixed(2)} Tm (${escapePdfString(op.str)}) Tj\n`;
      }
      out += 'ET\n';
    }
    for (const l of page.lineOps) {
      out += `q 0.85 0.83 0.78 RG 0.6 w ${l.x1.toFixed(2)} ${l.y1.toFixed(2)} m ${l.x2.toFixed(2)} ${l.y2.toFixed(2)} l S Q\n`;
    }
    return out;
  }

  toBuffer() {
    const objects = [];
    const addObject = (body) => {
      objects.push(body);
      return objects.length; // 1-based PDF object number
    };

    const fontRegularNum = addObject('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>');
    const fontBoldNum = addObject('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>');

    const contentObjNums = this.pages.map((page) => {
      const stream = this._renderPageStream(page);
      return addObject(`<< /Length ${Buffer.byteLength(stream, 'latin1')} >>\nstream\n${stream}endstream`);
    });

    const pagesObjNumExpected = objects.length + this.pages.length + 1;
    const pageObjNums = this.pages.map((page, i) =>
      addObject(
        `<< /Type /Page /Parent ${pagesObjNumExpected} 0 R /MediaBox [0 0 ${PAGE_WIDTH} ${PAGE_HEIGHT}] ` +
          `/Resources << /Font << /F1 ${fontRegularNum} 0 R /F2 ${fontBoldNum} 0 R >> >> /Contents ${contentObjNums[i]} 0 R >>`
      )
    );

    const kids = pageObjNums.map((n) => `${n} 0 R`).join(' ');
    const pagesObjNum = addObject(`<< /Type /Pages /Kids [${kids}] /Count ${pageObjNums.length} >>`);
    const catalogObjNum = addObject(`<< /Type /Catalog /Pages ${pagesObjNum} 0 R >>`);

    let out = '%PDF-1.4\n';
    const offsets = [0]; // object 0 is the free-list head, never written as "n"
    for (let i = 0; i < objects.length; i++) {
      offsets.push(Buffer.byteLength(out, 'latin1'));
      out += `${i + 1} 0 obj\n${objects[i]}\nendobj\n`;
    }
    const xrefOffset = Buffer.byteLength(out, 'latin1');
    out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
    for (let i = 1; i <= objects.length; i++) {
      out += `${String(offsets[i]).padStart(10, '0')} 00000 n \n`;
    }
    out += `trailer\n<< /Size ${objects.length + 1} /Root ${catalogObjNum} 0 R >>\nstartxref\n${xrefOffset}\n%%EOF`;

    return Buffer.from(out, 'latin1');
  }

  save(filePath) {
    fs.writeFileSync(filePath, this.toBuffer());
  }
}

module.exports = { PdfDoc, condense, sanitizeForPdf };

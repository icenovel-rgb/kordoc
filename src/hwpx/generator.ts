/**
 * Markdown → HWPX 역변환
 *
 * 지원: 헤딩(h1~h6), 단락, 볼드, 이탤릭, 인라인코드, 코드블록,
 *       순서/비순서 리스트, 수평선, 인용문, 테이블
 * jszip으로 HWPX ZIP 패키징.
 */

import JSZip from "jszip"

const NS_SECTION = "http://www.hancom.co.kr/hwpml/2011/section"
const NS_PARA = "http://www.hancom.co.kr/hwpml/2011/paragraph"
const NS_HEAD = "http://www.hancom.co.kr/hwpml/2011/head"
const NS_CORE = "http://www.hancom.co.kr/hwpml/2011/core"
const NS_APP = "http://www.hancom.co.kr/hwpml/2011/app"
const NS_OPF = "http://www.idpf.org/2007/opf/"
const NS_HPF = "http://www.hancom.co.kr/schema/2011/hpf"
const NS_OCF = "urn:oasis:names:tc:opendocument:xmlns:container"

// ─── 스타일 ID 매핑 ─────────────────────────────────
// charPr: 0=본문, 1=볼드, 2=이탤릭, 3=볼드이탤릭, 4=인라인코드, 5=h1, 6=h2, 7=h3, 8=h4~h6, 9=표 헤더 셀, 10=인용문
// paraPr: 0=본문, 1=h1, 2=h2, 3=h3, 4=h4~h6, 5=코드블록, 6=인용문, 7=리스트

const CHAR_NORMAL = 0
const CHAR_BOLD = 1
const CHAR_ITALIC = 2
const CHAR_BOLD_ITALIC = 3
const CHAR_CODE = 4
const CHAR_H1 = 5
const CHAR_H2 = 6
const CHAR_H3 = 7
const CHAR_H4 = 8
const CHAR_TABLE_HEADER = 9
const CHAR_QUOTE = 10

const PARA_NORMAL = 0
const PARA_H1 = 1
const PARA_H2 = 2
const PARA_H3 = 3
const PARA_H4 = 4
const PARA_CODE = 5
const PARA_QUOTE = 6
const PARA_LIST = 7
const PARA_TABLE_CELL = 8
// borderFill id는 1-기반이어야 한다(한컴은 1-기반 위치로 해석 — id=0이 있으면 채움/테두리가 한 칸씩 밀림).
// 고정 borderFill 2개(id 1=무테두리, 2=실선) 다음 id(3)부터 동적 표 테두리 할당.
const BF_TABLE_BASE = 3

/** 표 셀 테두리/채움 명세 — 위치(머리/본문/끝행 × 좌/중/우)로 결정 */
interface CellBorderSpec {
  left: { type: string; w: string }
  right: { type: string; w: string }
  top: { type: string; w: string }
  bottom: { type: string; w: string }
  fill: string | null
}
/** 표 테두리 borderFill 레지스트리 항목 (서명으로 중복 제거) */
interface TableBorderFill { sig: string; id: number; xml: string }

const B_DASH = { type: "DASH", w: "0.12 mm" }
const B_SOLID = { type: "SOLID", w: "0.12 mm" }
const B_THICK = { type: "SOLID", w: "0.4 mm" }
const B_NONE = { type: "NONE", w: "0.1 mm" }

/** 깔보디노 표 스타일: (r,c) 위치 → 셀 테두리/채움 명세 */
function kalbodinoCellSpec(r: number, c: number, R: number, C: number, headerBg: string): CellBorderSpec {
  const firstCol = c === 0, lastCol = c === C - 1, header = r === 0, lastRow = r === R - 1
  return {
    left: firstCol ? B_NONE : B_DASH,   // 좌우 외곽 없음, 안쪽 세로는 점선
    right: lastCol ? B_NONE : B_DASH,
    top: header ? B_THICK : B_SOLID,    // 머리행 위 굵은선, 그 외 실선
    bottom: lastRow ? B_THICK : B_SOLID, // 표 맨 아래 굵은선
    fill: header ? headerBg : null,      // 머리행만 배경색
  }
}

function borderFillXml(id: number, s: CellBorderSpec): string {
  return `      <hh:borderFill id="${id}" threeD="0" shadow="0" centerLine="NONE" breakCellSeparateLine="0">
        <hh:slash type="NONE" Crooked="0" isCounter="0"/>
        <hh:backSlash type="NONE" Crooked="0" isCounter="0"/>
        <hh:leftBorder type="${s.left.type}" width="${s.left.w}" color="#000000"/>
        <hh:rightBorder type="${s.right.type}" width="${s.right.w}" color="#000000"/>
        <hh:topBorder type="${s.top.type}" width="${s.top.w}" color="#000000"/>
        <hh:bottomBorder type="${s.bottom.type}" width="${s.bottom.w}" color="#000000"/>${s.fill ? `
        <hc:fillBrush><hc:winBrush faceColor="${s.fill}" hatchColor="#000000" alpha="0"/></hc:fillBrush>` : ""}
      </hh:borderFill>`
}

/** 명세를 레지스트리에 등록(중복 제거)하고 borderFill id 반환 */
function registerBorderFill(registry: TableBorderFill[], spec: CellBorderSpec): number {
  const sig = JSON.stringify(spec)
  const hit = registry.find(e => e.sig === sig)
  if (hit) return hit.id
  const id = BF_TABLE_BASE + registry.length
  registry.push({ sig, id, xml: borderFillXml(id, spec) })
  return id
}

/** HWPX 생성 시 적용할 시각 테마 (모두 선택) */
export interface HwpxTheme {
  /**
   * 헤딩 레벨별 텍스트 색상. 미지정 시 검정.
   * 현재 charPr 매핑은 h1/h2/h3/h4 4단계 (h5, h6은 h4와 같은 charPr 공유)이므로
   * 키는 1~4만 받는다.
   */
  headingColors?: Partial<Record<1 | 2 | 3 | 4, string>>
  /** 본문 단락 텍스트 색상. 미지정 시 검정 */
  bodyColor?: string
  /**
   * 인용문 텍스트 색상. 미지정 시 검정.
   *
   * 주의: 이 옵션을 지정하면 인용문이 별도 charPr(이탤릭)로 렌더링된다.
   * 미지정 시 기존 동작 그대로 본문 charPr로 렌더링 (이탤릭 아님).
   */
  quoteColor?: string
  /** 표 첫 행 텍스트 색상. 미지정 시 본문과 동일 */
  tableHeaderColor?: string
  /** 표 첫 행 텍스트를 굵게 표시 (기본 false) */
  tableHeaderBold?: boolean
  /** 표 첫 행 셀 배경색(HEX). 미지정 시 배경 없음. 책 권장 #4A6672(어두운 청회색). */
  tableHeaderBg?: string
  /**
   * 표 테두리 스타일. "default"=모든 셀 실선(기존). "kalbodino"=책 스타일
   * (좌우 외곽 없음·세로 점선·가로 실선·머리행 상단/표 하단 굵은선·머리행 배경).
   */
  tableStyle?: "default" | "kalbodino"
  /**
   * 본문 줄간격(%). 미지정 시 160. 깔끔한 보고서는 180 권장(가독성).
   * 참고: 서봉국 『깔끔한 보고서 디자인 노하우』.
   */
  bodyLineSpacing?: number
  /** 표 셀 내부 줄간격(%). 미지정 시 160. 책 권장 130(본문보다 좁게). */
  tableCellLineSpacing?: number
}

/** 이미지 배치(본문 어우러짐) 옵션 */
export interface ImageLayout {
  /**
   * 글자처럼 취급(true=인라인, hp:pos treatAsChar="1"). 기본 true.
   * false면 부유(floating) 개체로 배치되어 아래 textWrap이 적용된다.
   */
  treatAsChar?: boolean
  /**
   * treatAsChar=false일 때 본문과의 어우러짐.
   * SQUARE=어울림, TOP_AND_BOTTOM=자리차지, BEHIND_TEXT=글 뒤로, IN_FRONT_OF_TEXT=글 앞으로.
   * 기본 TOP_AND_BOTTOM.
   */
  textWrap?: "SQUARE" | "TOP_AND_BOTTOM" | "BEHIND_TEXT" | "IN_FRONT_OF_TEXT"
  /** SQUARE 등에서 본문이 흐를 방향. BOTH_SIDES/LEFT_ONLY/RIGHT_ONLY/LARGEST. 기본 BOTH_SIDES. */
  textFlow?: "BOTH_SIDES" | "LEFT_ONLY" | "RIGHT_ONLY" | "LARGEST"
}

/** markdownToHwpx 옵션 */
export interface MarkdownToHwpxOptions {
  theme?: HwpxTheme
  /** 모든 이미지에 적용할 기본 배치(어우러짐) 옵션. 미지정 시 글자처럼 취급(인라인). */
  imageLayout?: ImageLayout
  /**
   * 마크다운 본문의 `![alt](src)` 이미지를 HWPX에 임베드하기 위한 바이너리 맵.
   * 키 = 마크다운의 src 문자열(예: "images/fig1.png" 또는 "fig1.png"), 값 = 이미지 바이트.
   * src 정확 일치 우선, 없으면 basename(파일명만) 일치로 폴백한다.
   * 맵에 없는 src는 깨진 임베드 대신 `[그림: <src>]` 자리표시 단락으로 출력한다.
   */
  images?: Map<string, Uint8Array | ArrayBuffer>
}

/** 임베드된 이미지 1건 — ZIP BinData 엔트리 + manifest item 생성에 사용 */
interface EmbeddedImage {
  /** binItem id 겸 BinData 파일명 base (예: "image1") */
  id: string
  /** 확장자 (소문자, 점 없음): png|jpg|gif|bmp */
  ext: string
  /** MIME 타입 */
  mime: string
  /** 이미지 바이트 */
  data: Uint8Array
}

/** 매직바이트로 이미지 포맷 판별 → {ext, mime}. 미상이면 png로 가정. */
function detectImageType(bytes: Uint8Array): { ext: string; mime: string } {
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47)
    return { ext: "png", mime: "image/png" }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff)
    return { ext: "jpg", mime: "image/jpeg" }
  if (bytes.length >= 6 && bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46)
    return { ext: "gif", mime: "image/gif" }
  if (bytes.length >= 2 && bytes[0] === 0x42 && bytes[1] === 0x4d)
    return { ext: "bmp", mime: "image/bmp" }
  return { ext: "png", mime: "image/png" }
}

/** PNG/JPEG/GIF/BMP 헤더에서 픽셀 크기 추출. 실패 시 null. */
function readImageSize(bytes: Uint8Array): { w: number; h: number } | null {
  // PNG: IHDR at offset 16 (width @16, height @20), big-endian
  if (bytes.length >= 24 && bytes[0] === 0x89 && bytes[1] === 0x50) {
    const w = (bytes[16] << 24) | (bytes[17] << 16) | (bytes[18] << 8) | bytes[19]
    const h = (bytes[20] << 24) | (bytes[21] << 16) | (bytes[22] << 8) | bytes[23]
    if (w > 0 && h > 0) return { w, h }
  }
  // GIF: width/height little-endian at offset 6
  if (bytes.length >= 10 && bytes[0] === 0x47 && bytes[1] === 0x49) {
    const w = bytes[6] | (bytes[7] << 8)
    const h = bytes[8] | (bytes[9] << 8)
    if (w > 0 && h > 0) return { w, h }
  }
  // BMP: width/height little-endian at offset 18/22
  if (bytes.length >= 26 && bytes[0] === 0x42 && bytes[1] === 0x4d) {
    const w = bytes[18] | (bytes[19] << 8) | (bytes[20] << 16) | (bytes[21] << 24)
    const h = bytes[22] | (bytes[23] << 8) | (bytes[24] << 16) | (bytes[25] << 24)
    if (w > 0 && h > 0) return { w, h: Math.abs(h) }
  }
  // JPEG: scan SOF0/2 markers
  if (bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8) {
    let off = 2
    while (off + 9 < bytes.length) {
      if (bytes[off] !== 0xff) { off++; continue }
      const marker = bytes[off + 1]
      // SOF0..SOF3, SOF5..SOF7, SOF9..SOF11, SOF13..SOF15
      if ((marker >= 0xc0 && marker <= 0xc3) || (marker >= 0xc5 && marker <= 0xc7) ||
          (marker >= 0xc9 && marker <= 0xcb) || (marker >= 0xcd && marker <= 0xcf)) {
        const h = (bytes[off + 5] << 8) | bytes[off + 6]
        const w = (bytes[off + 7] << 8) | bytes[off + 8]
        if (w > 0 && h > 0) return { w, h }
        break
      }
      const len = (bytes[off + 2] << 8) | bytes[off + 3]
      if (len <= 0) break
      off += 2 + len
    }
  }
  return null
}

function toU8(d: Uint8Array | ArrayBuffer): Uint8Array {
  return d instanceof Uint8Array ? d : new Uint8Array(d)
}

const DEFAULT_TEXT_COLOR = "#000000"

function resolveTheme(theme?: HwpxTheme) {
  return {
    h1: theme?.headingColors?.[1] ?? DEFAULT_TEXT_COLOR,
    h2: theme?.headingColors?.[2] ?? DEFAULT_TEXT_COLOR,
    h3: theme?.headingColors?.[3] ?? DEFAULT_TEXT_COLOR,
    h4: theme?.headingColors?.[4] ?? theme?.headingColors?.[3] ?? DEFAULT_TEXT_COLOR,
    body: theme?.bodyColor ?? DEFAULT_TEXT_COLOR,
    quote: theme?.quoteColor ?? DEFAULT_TEXT_COLOR,
    /** quoteColor가 명시되었는지 — blockquote charPr 분기에 사용 (baseline 호환) */
    hasQuoteOption: theme?.quoteColor !== undefined,
    tableHeader: theme?.tableHeaderColor ?? theme?.bodyColor ?? DEFAULT_TEXT_COLOR,
    tableHeaderBold: !!theme?.tableHeaderBold,
    tableHeaderBg: theme?.tableHeaderBg ?? (theme?.tableStyle === "kalbodino" ? "#4A6672" : undefined),
    tableStyle: theme?.tableStyle ?? "default",
    bodyLineSpacing: theme?.bodyLineSpacing ?? 160,
    tableCellLineSpacing: theme?.tableCellLineSpacing ?? 160,
  }
}

type ResolvedTheme = ReturnType<typeof resolveTheme>

/**
 * 마크다운 텍스트를 HWPX (ArrayBuffer)로 변환.
 */
export async function markdownToHwpx(
  markdown: string,
  options?: MarkdownToHwpxOptions,
): Promise<ArrayBuffer> {
  const theme = resolveTheme(options?.theme)
  const blocks = parseMarkdownToBlocks(markdown)
  const images: EmbeddedImage[] = []
  const tableBorderFills: TableBorderFill[] = []
  const sectionXml = blocksToSectionXml(blocks, theme, options?.images, images, options?.imageLayout, tableBorderFills)

  const zip = new JSZip()
  zip.file("mimetype", "application/hwp+zip", { compression: "STORE" })
  zip.file("version.xml", generateVersionXml())
  zip.file("settings.xml", generateSettingsXml())
  zip.file("META-INF/container.xml", generateContainerXml())
  zip.file("META-INF/container.rdf", generateContainerRdf())
  zip.file("META-INF/manifest.xml", generateOdfManifest())
  zip.file("Contents/content.hpf", generateManifest(images))
  zip.file("Contents/header.xml", generateHeaderXml(theme, tableBorderFills))
  zip.file("Contents/section0.xml", sectionXml)
  // 임베드 이미지 바이너리 — BinData/<id>.<ext> (manifest href와 일치)
  for (const img of images) {
    zip.file(`BinData/${img.id}.${img.ext}`, img.data)
  }
  // Preview/ — 한글 프로그램의 일부 버전(특히 macOS)이 존재 여부를 확인함
  zip.file("Preview/PrvText.txt", buildPrvText(blocks))

  return await zip.generateAsync({ type: "arraybuffer" })
}

/** Preview/PrvText.txt — 문서 앞부분 텍스트 스냅샷 (최대 1KB) */
function buildPrvText(blocks: MdBlock[]): string {
  const lines: string[] = []
  let bytes = 0
  for (const b of blocks) {
    const text = b.type === "image"
      ? `[그림${b.alt ? ": " + b.alt : ""}]`
      : b.text || (b.rows ? b.rows.map(r => r.join(" ")).join("\n") : "")
    if (!text) continue
    lines.push(text)
    bytes += text.length * 3
    if (bytes > 1024) break
  }
  return lines.join("\n").slice(0, 1024)
}

// ─── 마크다운 파싱 ───────────────────────────────────

interface MdBlock {
  type: "paragraph" | "heading" | "table" | "code_block" | "hr" | "blockquote" | "list_item" | "image"
  text?: string
  level?: number
  rows?: string[][]
  lang?: string
  ordered?: boolean
  indent?: number
  /** image 블록: 마크다운 ![alt](src)의 src (이미지 파일명/키) */
  src?: string
  /** image 블록: 대체 텍스트(alt). hp:shapeComment + 캡션 후보 */
  alt?: string
  /** image 블록: 지정 표시 폭(HWPUNIT). 미지정 시 원본 크기(본문 폭 한계까지). */
  width?: number
}

/** 이미지 크기 구문 파싱 ({width=8cm|120mm|50%|400px}) → 표시 폭(HWPUNIT). 미지정/미인식 시 undefined */
function parseImageWidth(spec?: string): number | undefined {
  if (!spec) return undefined
  const m = spec.match(/width\s*=\s*([\d.]+)\s*(cm|mm|px|%)?/i)
  if (!m) return undefined
  const v = parseFloat(m[1])
  if (!(v > 0)) return undefined
  const unit = (m[2] || "px").toLowerCase()
  if (unit === "cm") return Math.round(v * 2834.6)   // 1cm = 2834.6 HWPUNIT
  if (unit === "mm") return Math.round(v * 283.46)    // 1mm = 283.46 HWPUNIT
  if (unit === "%") return Math.round((IMG_BODY_WIDTH * v) / 100)
  return Math.round(v * PX_TO_HWPUNIT)                // px
}

function parseMarkdownToBlocks(md: string): MdBlock[] {
  const lines = md.split("\n")
  const blocks: MdBlock[] = []
  let i = 0

  while (i < lines.length) {
    const line = lines[i]

    // 빈 줄 스킵
    if (!line.trim()) { i++; continue }

    // 코드블록
    const fenceMatch = line.match(/^(`{3,}|~{3,})(.*)$/)
    if (fenceMatch) {
      const fence = fenceMatch[1]
      const lang = fenceMatch[2].trim()
      const codeLines: string[] = []
      i++
      while (i < lines.length && !lines[i].startsWith(fence)) {
        codeLines.push(lines[i])
        i++
      }
      if (i < lines.length) i++ // 닫는 fence
      blocks.push({ type: "code_block", text: codeLines.join("\n"), lang })
      continue
    }

    // 수평선
    if (/^(\*{3,}|-{3,}|_{3,})\s*$/.test(line.trim())) {
      blocks.push({ type: "hr" })
      i++; continue
    }

    // 헤딩
    const headingMatch = line.match(/^(#{1,6})\s+(.+)$/)
    if (headingMatch) {
      blocks.push({ type: "heading", text: headingMatch[2].trim(), level: headingMatch[1].length })
      i++; continue
    }

    // 이미지 (단독 라인 ![alt](src) [+ 선택 {width=8cm|50%|400px}]) — 임베드 대상
    const imageMatch = line.trim().match(/^!\[([^\]]*)\]\(([^)]+)\)(?:\{([^}]*)\})?$/)
    if (imageMatch) {
      blocks.push({
        type: "image",
        alt: imageMatch[1].trim(),
        src: imageMatch[2].trim(),
        width: parseImageWidth(imageMatch[3]),
      })
      i++; continue
    }

    // 테이블
    if (line.trimStart().startsWith("|")) {
      const tableRows: string[][] = []
      while (i < lines.length && lines[i].trimStart().startsWith("|")) {
        const row = lines[i]
        if (/^[\s|:\-]+$/.test(row)) { i++; continue }
        const cells = row.split("|").slice(1, -1).map(c => c.trim())
        if (cells.length > 0) tableRows.push(cells)
        i++
      }
      if (tableRows.length > 0) blocks.push({ type: "table", rows: tableRows })
      continue
    }

    // 인용문
    if (line.trimStart().startsWith("> ")) {
      const quoteLines: string[] = []
      while (i < lines.length && (lines[i].trimStart().startsWith("> ") || lines[i].trimStart().startsWith(">"))) {
        quoteLines.push(lines[i].replace(/^>\s?/, ""))
        i++
      }
      for (const ql of quoteLines) {
        blocks.push({ type: "blockquote", text: ql.trim() || "" })
      }
      continue
    }

    // 리스트
    const listMatch = line.match(/^(\s*)([-*+]|\d+[.)]) (.+)$/)
    if (listMatch) {
      const indent = Math.floor(listMatch[1].length / 2)
      const ordered = /\d/.test(listMatch[2])
      blocks.push({ type: "list_item", text: listMatch[3].trim(), ordered, indent })
      i++; continue
    }

    // 일반 단락
    blocks.push({ type: "paragraph", text: line.trim() })
    i++
  }

  return blocks
}

// ─── 인라인 마크다운 → 멀티 run ─────────────────────

interface InlineSpan {
  text: string
  bold: boolean
  italic: boolean
  code: boolean
}

function parseInlineMarkdown(text: string): InlineSpan[] {
  // 전처리: 마크다운 링크/이미지 → 텍스트만 추출
  text = text.replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")   // ![alt](url) → alt
  text = text.replace(/\[([^\]]*)\]\(([^)]*)\)/g, (_, t, u) => t || u) // [text](url) → text or url
  // 전처리: ~~취소선~~ → 텍스트만
  text = text.replace(/~~([^~]+)~~/g, "$1")

  const spans: InlineSpan[] = []
  // 패턴: `code`, ***bolditalic***, **bold**, *italic*, __bold__, _italic_
  const regex = /(`[^`]+`|\*{3}[^*]+\*{3}|\*{2}[^*]+\*{2}|\*[^*]+\*|_{2}[^_]+_{2}|_[^_]+_)/g
  let lastIdx = 0

  for (const match of text.matchAll(regex)) {
    const idx = match.index!
    if (idx > lastIdx) {
      spans.push({ text: text.slice(lastIdx, idx), bold: false, italic: false, code: false })
    }
    const raw = match[0]
    if (raw.startsWith("`")) {
      spans.push({ text: raw.slice(1, -1), bold: false, italic: false, code: true })
    } else if (raw.startsWith("***") || raw.startsWith("___")) {
      spans.push({ text: raw.slice(3, -3), bold: true, italic: true, code: false })
    } else if (raw.startsWith("**") || raw.startsWith("__")) {
      spans.push({ text: raw.slice(2, -2), bold: true, italic: false, code: false })
    } else {
      spans.push({ text: raw.slice(1, -1), bold: false, italic: true, code: false })
    }
    lastIdx = idx + raw.length
  }
  if (lastIdx < text.length) {
    spans.push({ text: text.slice(lastIdx), bold: false, italic: false, code: false })
  }
  if (spans.length === 0) {
    spans.push({ text, bold: false, italic: false, code: false })
  }
  return spans
}

function spanToCharPrId(span: InlineSpan): number {
  if (span.code) return CHAR_CODE
  if (span.bold && span.italic) return CHAR_BOLD_ITALIC
  if (span.bold) return CHAR_BOLD
  if (span.italic) return CHAR_ITALIC
  return CHAR_NORMAL
}

// ─── XML 생성 헬퍼 ───────────────────────────────────

function escapeXml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
}

function generateRuns(text: string, defaultCharPr: number = CHAR_NORMAL): string {
  const spans = parseInlineMarkdown(text)
  return spans.map(span => {
    const charId = span.code || span.bold || span.italic ? spanToCharPrId(span) : defaultCharPr
    return `<hp:run charPrIDRef="${charId}"><hp:t>${escapeXml(span.text)}</hp:t></hp:run>`
  }).join("")
}

function generateParagraph(text: string, paraPrId: number = PARA_NORMAL, charPrId: number = CHAR_NORMAL): string {
  if (paraPrId === PARA_CODE) {
    // 코드블록은 인라인 파싱 안 함
    return `<hp:p paraPrIDRef="${paraPrId}" styleIDRef="0"><hp:run charPrIDRef="${CHAR_CODE}"><hp:t>${escapeXml(text)}</hp:t></hp:run></hp:p>`
  }
  const runs = generateRuns(text, charPrId)
  return `<hp:p paraPrIDRef="${paraPrId}" styleIDRef="0">${runs}</hp:p>`
}

function headingParaPrId(level: number): number {
  if (level === 1) return PARA_H1
  if (level === 2) return PARA_H2
  if (level === 3) return PARA_H3
  return PARA_H4
}

function headingCharPrId(level: number): number {
  if (level === 1) return CHAR_H1
  if (level === 2) return CHAR_H2
  if (level === 3) return CHAR_H3
  return CHAR_H4
}

// ─── HWPX 구조 파일 생성 ─────────────────────────────

function generateContainerXml(): string {
  // 실제 한컴 HWPX는 content.hpf + Preview/PrvText.txt + META-INF/container.rdf 3개를 rootfile로 등록한다.
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes" ?>
<ocf:container xmlns:ocf="${NS_OCF}" xmlns:hpf="${NS_HPF}"><ocf:rootfiles><ocf:rootfile full-path="Contents/content.hpf" media-type="application/hwpml-package+xml"/><ocf:rootfile full-path="Preview/PrvText.txt" media-type="text/plain"/><ocf:rootfile full-path="META-INF/container.rdf" media-type="application/rdf+xml"/></ocf:rootfiles></ocf:container>`
}

/** version.xml — 한컴 HWPX 필수. 미존재 시 일부 버전이 "파일을 읽을 수 없음"으로 거부. */
function generateVersionXml(): string {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes" ?>
<hv:HCFVersion xmlns:hv="http://www.hancom.co.kr/hwpml/2011/version" tagetApplication="WORDPROCESSOR" major="5" minor="1" micro="1" buildNumber="0" os="1" xmlVersion="1.5" application="kordoc" appVersion="1.0"/>`
}

/** settings.xml — 한컴 HWPX 필수. 최소 본문(빈 설정). */
function generateSettingsXml(): string {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes" ?>
<ha:HWPApplicationSetting xmlns:ha="${NS_APP}" xmlns:config="urn:oasis:names:tc:opendocument:xmlns:config:1.0"><ha:CaretPosition listIDRef="0" paraIDRef="0" pos="0"/></ha:HWPApplicationSetting>`
}

/** META-INF/container.rdf — 패키지 구성요소 RDF 기술. */
function generateContainerRdf(): string {
  const NS_PKG = "http://www.hancom.co.kr/hwpml/2016/meta/pkg#"
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes" ?>
<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:Description rdf:about=""><ns0:hasPart xmlns:ns0="${NS_PKG}" rdf:resource="Contents/header.xml"/></rdf:Description><rdf:Description rdf:about="Contents/header.xml"><rdf:type rdf:resource="${NS_PKG}HeaderFile"/></rdf:Description><rdf:Description rdf:about=""><ns0:hasPart xmlns:ns0="${NS_PKG}" rdf:resource="Contents/section0.xml"/></rdf:Description><rdf:Description rdf:about="Contents/section0.xml"><rdf:type rdf:resource="${NS_PKG}SectionFile"/></rdf:Description><rdf:Description rdf:about=""><rdf:type rdf:resource="${NS_PKG}Document"/></rdf:Description></rdf:RDF>`
}

/** META-INF/manifest.xml — ODF 매니페스트(빈). */
function generateOdfManifest(): string {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes" ?>
<odf:manifest xmlns:odf="urn:oasis:names:tc:opendocument:xmlns:manifest:1.0"/>`
}

function generateManifest(images: EmbeddedImage[] = []): string {
  const imageItems = images
    .map(img => `    <opf:item id="${img.id}" href="BinData/${img.id}.${img.ext}" media-type="${img.mime}" isEmbeded="1"/>`)
    .join("\n")
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes" ?>
<opf:package xmlns:opf="${NS_OPF}" xmlns:hpf="${NS_HPF}" xmlns:hh="${NS_HEAD}">
  <opf:manifest>
${imageItems ? imageItems + "\n" : ""}    <opf:item id="header" href="Contents/header.xml" media-type="application/xml"/>
    <opf:item id="section0" href="Contents/section0.xml" media-type="application/xml"/>
    <opf:item id="settings" href="settings.xml" media-type="application/xml"/>
  </opf:manifest>
  <opf:spine>
    <opf:itemref idref="header" linear="yes"/>
    <opf:itemref idref="section0" linear="yes"/>
  </opf:spine>
</opf:package>`
}

// ─── charPr 생성 헬퍼 ───────────────────────────────

function charPr(
  id: number,
  height: number,
  bold: boolean,
  italic: boolean,
  fontId: number = 0,
  textColor: string = DEFAULT_TEXT_COLOR,
): string {
  const boldAttr = bold ? ` bold="1"` : ""
  const italicAttr = italic ? ` italic="1"` : ""
  // 볼드면 fontfaces의 bold variant(id=2: HY견고딕/Arial Black, weight=9) 참조해
  // macOS 한컴에서 합성 굵기 안 되는 케이스 커버. 코드(fontId=1)는 bold 아닌 경우에만
  // 원본 id 유지 (Consolas/함초롬돋움).
  const effFont = bold ? 2 : fontId
  return `      <hh:charPr id="${id}" height="${height}" textColor="${textColor}" shadeColor="none" useFontSpace="0" useKerning="0" symMark="NONE" borderFillIDRef="1"${boldAttr}${italicAttr}>
        <hh:fontRef hangul="${effFont}" latin="${effFont}" hanja="${effFont}" japanese="${effFont}" other="${effFont}" symbol="${effFont}" user="${effFont}"/>
        <hh:ratio hangul="100" latin="100" hanja="100" japanese="100" other="100" symbol="100" user="100"/>
        <hh:spacing hangul="0" latin="0" hanja="0" japanese="0" other="0" symbol="0" user="0"/>
        <hh:relSz hangul="100" latin="100" hanja="100" japanese="100" other="100" symbol="100" user="100"/>
        <hh:offset hangul="0" latin="0" hanja="0" japanese="0" other="0" symbol="0" user="0"/>
      </hh:charPr>`
}

// ─── paraPr 생성 헬퍼 ───────────────────────────────

function paraPr(id: number, opts: { align?: string; spaceBefore?: number; spaceAfter?: number; lineSpacing?: number; indent?: number } = {}): string {
  const { align = "JUSTIFY", spaceBefore = 0, spaceAfter = 0, lineSpacing = 160, indent = 0 } = opts
  // 한컴 2024는 margin을 자식 요소(<hc:prev value unit>)로 읽는다. 속성형(prev="...")은 무시되어
  // 문단 간격이 적용되지 않는다. lineSpacing에도 unit이 필요. <hp:switch>로 신/구 형식 모두 제공.
  const marginAndSpacing =
    `<hh:margin>` +
      `<hc:intent value="${indent}" unit="HWPUNIT"/>` +
      `<hc:left value="0" unit="HWPUNIT"/>` +
      `<hc:right value="0" unit="HWPUNIT"/>` +
      `<hc:prev value="${spaceBefore}" unit="HWPUNIT"/>` +
      `<hc:next value="${spaceAfter}" unit="HWPUNIT"/>` +
    `</hh:margin>` +
    `<hh:lineSpacing type="PERCENT" value="${lineSpacing}" unit="HWPUNIT"/>`
  return `      <hh:paraPr id="${id}" tabPrIDRef="0" condense="0" fontLineHeight="0" snapToGrid="1" suppressLineNumbers="0" checked="0" textDir="AUTO">
        <hh:align horizontal="${align}" vertical="BASELINE"/>
        <hh:heading type="NONE" idRef="0" level="0"/>
        <hh:breakSetting breakLatinWord="KEEP_WORD" breakNonLatinWord="BREAK_WORD" widowOrphan="0" keepWithNext="0" keepLines="0" pageBreakBefore="0" lineWrap="BREAK"/>
        <hh:autoSpacing eAsianEng="0" eAsianNum="0"/>
        <hp:switch><hp:case hp:required-namespace="http://www.hancom.co.kr/hwpml/2016/HwpUnitChar">${marginAndSpacing}</hp:case><hp:default>${marginAndSpacing}</hp:default></hp:switch>
        <hh:border borderFillIDRef="1" offsetLeft="0" offsetRight="0" offsetTop="0" offsetBottom="0" connect="0" ignoreMargin="0"/>
      </hh:paraPr>`
}

function generateHeaderXml(theme: ResolvedTheme, tableBorderFills: TableBorderFill[] = []): string {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes" ?>
<hh:head xmlns:hh="${NS_HEAD}" xmlns:hp="${NS_PARA}" xmlns:hc="${NS_CORE}" version="1.4" secCnt="1">
  <hh:beginNum page="1" footnote="1" endnote="1" pic="1" tbl="1" equation="1"/>
  <hh:refList>
    <hh:fontfaces itemCnt="7">
      <hh:fontface lang="HANGUL" fontCnt="3">
        <hh:font id="0" face="함초롬바탕" type="TTF" isEmbedded="0">
          <hh:typeInfo familyType="FCAT_GOTHIC" weight="6" proportion="4" contrast="0" strokeVariation="1" armStyle="1" letterform="1" midline="1" xHeight="1"/>
        </hh:font>
        <hh:font id="1" face="함초롬돋움" type="TTF" isEmbedded="0">
          <hh:typeInfo familyType="FCAT_GOTHIC" weight="6" proportion="4" contrast="0" strokeVariation="1" armStyle="1" letterform="1" midline="1" xHeight="1"/>
        </hh:font>
        <hh:font id="2" face="HY견고딕" type="TTF" isEmbedded="0">
          <hh:typeInfo familyType="FCAT_GOTHIC" weight="9" proportion="0" contrast="0" strokeVariation="1" armStyle="1" letterform="1" midline="1" xHeight="1"/>
        </hh:font>
      </hh:fontface>
      <hh:fontface lang="LATIN" fontCnt="3">
        <hh:font id="0" face="Times New Roman" type="TTF" isEmbedded="0">
          <hh:typeInfo familyType="FCAT_OLDSTYLE" weight="5" proportion="4" contrast="2" strokeVariation="0" armStyle="0" letterform="0" midline="0" xHeight="4"/>
        </hh:font>
        <hh:font id="1" face="Consolas" type="TTF" isEmbedded="0">
          <hh:typeInfo familyType="FCAT_MODERN" weight="5" proportion="0" contrast="0" strokeVariation="0" armStyle="0" letterform="0" midline="0" xHeight="0"/>
        </hh:font>
        <hh:font id="2" face="Arial Black" type="TTF" isEmbedded="0">
          <hh:typeInfo familyType="FCAT_GOTHIC" weight="9" proportion="0" contrast="0" strokeVariation="0" armStyle="0" letterform="0" midline="0" xHeight="0"/>
        </hh:font>
      </hh:fontface>
      <hh:fontface lang="HANJA" fontCnt="1">
        <hh:font id="0" face="함초롬바탕" type="TTF" isEmbedded="0">
          <hh:typeInfo familyType="FCAT_GOTHIC" weight="6" proportion="4" contrast="0" strokeVariation="1" armStyle="1" letterform="1" midline="1" xHeight="1"/>
        </hh:font>
      </hh:fontface>
      <hh:fontface lang="JAPANESE" fontCnt="1">
        <hh:font id="0" face="굴림" type="TTF" isEmbedded="0">
          <hh:typeInfo familyType="FCAT_GOTHIC" weight="6" proportion="0" contrast="0" strokeVariation="1" armStyle="1" letterform="1" midline="1" xHeight="1"/>
        </hh:font>
      </hh:fontface>
      <hh:fontface lang="OTHER" fontCnt="1">
        <hh:font id="0" face="굴림" type="TTF" isEmbedded="0">
          <hh:typeInfo familyType="FCAT_GOTHIC" weight="6" proportion="0" contrast="0" strokeVariation="1" armStyle="1" letterform="1" midline="1" xHeight="1"/>
        </hh:font>
      </hh:fontface>
      <hh:fontface lang="SYMBOL" fontCnt="1">
        <hh:font id="0" face="Symbol" type="TTF" isEmbedded="0">
          <hh:typeInfo familyType="FCAT_GOTHIC" weight="6" proportion="0" contrast="0" strokeVariation="1" armStyle="1" letterform="1" midline="1" xHeight="1"/>
        </hh:font>
      </hh:fontface>
      <hh:fontface lang="USER" fontCnt="1">
        <hh:font id="0" face="굴림" type="TTF" isEmbedded="0">
          <hh:typeInfo familyType="FCAT_GOTHIC" weight="6" proportion="0" contrast="0" strokeVariation="1" armStyle="1" letterform="1" midline="1" xHeight="1"/>
        </hh:font>
      </hh:fontface>
    </hh:fontfaces>
    <hh:borderFills itemCnt="${2 + tableBorderFills.length}">
      <hh:borderFill id="1" threeD="0" shadow="0" centerLine="0" breakCellSeparateLine="0">
        <hh:slash type="NONE" Crooked="0" isCounter="0"/>
        <hh:backSlash type="NONE" Crooked="0" isCounter="0"/>
        <hh:leftBorder type="NONE" width="0.1 mm" color="#000000"/>
        <hh:rightBorder type="NONE" width="0.1 mm" color="#000000"/>
        <hh:topBorder type="NONE" width="0.1 mm" color="#000000"/>
        <hh:bottomBorder type="NONE" width="0.1 mm" color="#000000"/>
        <hh:diagonal type="NONE" width="0.1 mm" color="#000000"/>
        <hh:fillInfo/>
      </hh:borderFill>
      <hh:borderFill id="2" threeD="0" shadow="0" centerLine="0" breakCellSeparateLine="0">
        <hh:slash type="NONE" Crooked="0" isCounter="0"/>
        <hh:backSlash type="NONE" Crooked="0" isCounter="0"/>
        <hh:leftBorder type="SOLID" width="0.12 mm" color="#000000"/>
        <hh:rightBorder type="SOLID" width="0.12 mm" color="#000000"/>
        <hh:topBorder type="SOLID" width="0.12 mm" color="#000000"/>
        <hh:bottomBorder type="SOLID" width="0.12 mm" color="#000000"/>
        <hh:diagonal type="NONE" width="0.1 mm" color="#000000"/>
        <hh:fillInfo/>
      </hh:borderFill>${tableBorderFills.length ? "\n" + tableBorderFills.map(e => e.xml).join("\n") : ""}
    </hh:borderFills>
    <hh:charProperties itemCnt="11">
${charPr(0, 1000, false, false, 0, theme.body)}
${charPr(1, 1000, true, false, 0, theme.body)}
${charPr(2, 1000, false, true, 0, theme.body)}
${charPr(3, 1000, true, true, 0, theme.body)}
${charPr(4, 900, false, false, 1)}
${charPr(5, 1800, true, false, 1, theme.h1)}
${charPr(6, 1400, true, false, 1, theme.h2)}
${charPr(7, 1200, true, false, 1, theme.h3)}
${charPr(8, 1100, true, false, 1, theme.h4)}
${charPr(CHAR_TABLE_HEADER, 1000, theme.tableHeaderBold, false, 0, theme.tableHeader)}
${charPr(CHAR_QUOTE, 1000, false, true, 0, theme.quote)}
    </hh:charProperties>
    <hh:tabProperties itemCnt="0"/>
    <hh:numberings itemCnt="0"/>
    <hh:bullets itemCnt="0"/>
    <hh:paraProperties itemCnt="9">
${paraPr(0, { lineSpacing: theme.bodyLineSpacing })}
${paraPr(1, { align: "LEFT", spaceBefore: 2400, spaceAfter: 600, lineSpacing: 180 })}
${paraPr(2, { align: "LEFT", spaceBefore: 1700, spaceAfter: 400, lineSpacing: 170 })}
${paraPr(3, { align: "LEFT", spaceBefore: 1200, spaceAfter: 300, lineSpacing: 160 })}
${paraPr(4, { align: "LEFT", spaceBefore: 900, spaceAfter: 200, lineSpacing: 160 })}
${paraPr(5, { align: "LEFT", lineSpacing: 130, indent: 400 })}
${paraPr(6, { align: "LEFT", lineSpacing: 150, indent: 600 })}
${paraPr(7, { align: "LEFT", lineSpacing: 160, indent: 600 })}
${paraPr(8, { align: "LEFT", lineSpacing: theme.tableCellLineSpacing })}
    </hh:paraProperties>
    <hh:styles itemCnt="1">
      <hh:style id="0" type="PARA" name="바탕글" engName="Normal" paraPrIDRef="0" charPrIDRef="0" nextStyleIDRef="0" langIDRef="1042" lockForm="0"/>
    </hh:styles>
  </hh:refList>
  <hh:compatibleDocument targetProgram="HWP2018"/>
</hh:head>`
}

// ─── 섹션 속성 (공문서 표준 여백) ────────────────────

function generateSecPr(): string {
  // A4: 210mm × 297mm → 59528 × 84188 HWPUNIT (1mm ≈ 283.46 HWPUNIT)
  // 공문서 표준: 위 30mm(8504), 아래 15mm(4252), 왼쪽 20mm(5670), 오른쪽 15mm(4252)
  // 머리말 10mm(2835), 꼬리말 10mm(2835)
  return `<hp:secPr textDirection="HORIZONTAL" spaceColumns="1134" tabStop="8000" outlineShapeIDRef="0" memoShapeIDRef="0" textVerticalWidthHead="0" masterPageCnt="0">` +
    `<hp:grid lineGrid="0" charGrid="0" wonggojiFormat="0"/>` +
    `<hp:startNum pageStartsOn="BOTH" page="0" pic="0" tbl="0" equation="0"/>` +
    `<hp:visibility hideFirstHeader="0" hideFirstFooter="0" hideFirstMasterPage="0" border="SHOW_ALL" fill="SHOW_ALL" hideFirstPageNum="0" hideFirstEmptyLine="0" showLineNumber="0"/>` +
    `<hp:pagePr landscape="WIDELY" width="59528" height="84188" gutterType="LEFT_ONLY">` +
      `<hp:margin header="2835" footer="2835" gutter="0" left="5670" right="4252" top="8504" bottom="4252"/>` +
    `</hp:pagePr>` +
    `<hp:footNotePr><hp:autoNumFormat type="DIGIT" userChar="" prefixChar="" suffixChar=")" supscript="0"/><hp:noteLine length="-1" type="SOLID" width="0.12 mm" color="#000000"/><hp:noteSpacing betweenNotes="283" belowLine="567" aboveLine="850"/><hp:numbering type="CONTINUOUS" newNum="1"/><hp:placement place="EACH_COLUMN" beneathText="0"/></hp:footNotePr>` +
    `<hp:endNotePr><hp:autoNumFormat type="DIGIT" userChar="" prefixChar="" suffixChar=")" supscript="0"/><hp:noteLine length="14692344" type="SOLID" width="0.12 mm" color="#000000"/><hp:noteSpacing betweenNotes="0" belowLine="567" aboveLine="850"/><hp:numbering type="CONTINUOUS" newNum="1"/><hp:placement place="END_OF_DOCUMENT" beneathText="0"/></hp:endNotePr>` +
  `</hp:secPr>`
}

// ─── 테이블 생성 ─────────────────────────────────────
//
// HWPX 스펙 완전 준수 버전 — 한글 프로그램(Windows/macOS)이 문서를 거부하지 않으려면
// <hp:tbl> 필수 속성 + <hp:sz>/<hp:pos>/<hp:outMargin>/<hp:inMargin> + 각 cell의
// <hp:subList> 래퍼, <hp:cellAddr>, <hp:cellSz>, <hp:cellMargin>이 전부 있어야 함.
// 또한 테이블은 paragraph 안의 <hp:run><hp:ctrl>... 로 감싸야 한다.
//
// 이슈 #4 참고: v2.4.1 이전엔 최소 스켈레톤만 내서 macOS 한글이 "파일이 깨졌다"며 거부.

// 기본 셀 크기 (HWPUnit) — A4 기준 적당한 기본값
const TABLE_ID_BASE = 1000
let tableIdCounter = TABLE_ID_BASE
function nextTableId(): number { return ++tableIdCounter }

function generateTable(
  rows: string[][],
  theme: ResolvedTheme,
  images?: Map<string, Uint8Array | ArrayBuffer>,
  registry?: EmbeddedImage[],
  borderFills?: TableBorderFill[],
): string {
  const rowCnt = rows.length
  const colCnt = Math.max(...rows.map(r => r.length), 1)
  // A4 portrait: 폭 약 44000 HWPUnit 사용 가능 → colCnt로 균등 분배
  const cellW = Math.floor(44000 / colCnt)
  const cellH = 2066  // 기본 행 높이 (한컴 실측값 — 너무 낮으면 글자 잘림)
  const tblW = cellW * colCnt
  const tblH = cellH * rowCnt

  const tblId = nextTableId()
  const kalbodino = theme.tableStyle === "kalbodino" && !!borderFills

  // theme.tableHeaderColor 또는 tableHeaderBold가 설정되면 첫 행 셀에 별도 charPr 사용
  const useHeaderStyle =
    theme.tableHeader !== theme.body || theme.tableHeaderBold

  const trElements = rows.map((row, rowIdx) => {
    // 부족한 셀은 빈 문자열로 채워 colCnt 맞춤
    const cells = row.length < colCnt ? [...row, ...Array(colCnt - row.length).fill("")] : row
    const isHeaderRow = rowIdx === 0
    const headerCharPr = isHeaderRow && useHeaderStyle ? CHAR_TABLE_HEADER : CHAR_NORMAL
    const tdElements = cells.map((cell, colIdx) => {
      // 셀 테두리: 깔보디노 스타일이면 위치별 borderFill, 아니면 기본(1)
      const cellBorderFill = kalbodino
        ? registerBorderFill(borderFills!, kalbodinoCellSpec(rowIdx, colIdx, rowCnt, colCnt, theme.tableHeaderBg || "#4A6672"))
        : 2
      // 셀 내용이 단독 이미지 ![alt](src)이고 바이너리가 있으면 셀에 그림 임베드
      const imgM = cell.match(/^!\[([^\]]*)\]\(([^)]+)\)$/)
      let p: string
      const imgData = imgM ? resolveImageData(imgM[2].trim(), images) : null
      if (imgM && imgData && registry) {
        const { ext, mime } = detectImageType(imgData)
        const id = `image${registry.length + 1}`
        registry.push({ id, ext, mime, data: imgData })
        const { w, h, origW, origH } = computeImageSizeHwp(imgData)
        // 셀 안 이미지는 글자처럼 취급(인라인)으로 고정 — 셀 내 부유 배치는 비권장
        p = generateImage(id, w, h, origW, origH, imgM[1].trim(), { treatAsChar: true })
      } else {
        const runs = generateRuns(cell, headerCharPr)
        p = `<hp:p paraPrIDRef="${PARA_TABLE_CELL}" styleIDRef="0">${runs}</hp:p>`
      }
      // <hp:tc> 필수 속성 + subList + cellAddr + cellSpan + cellSz + cellMargin
      return `<hp:tc name="" header="${isHeaderRow ? 1 : 0}" hasMargin="0" protect="0" editable="1" dirty="0" borderFillIDRef="${cellBorderFill}">`
        + `<hp:subList id="" textDirection="HORIZONTAL" lineWrap="BREAK" vertAlign="CENTER" linkListIDRef="0" linkListNextIDRef="0" textWidth="0" textHeight="0" hasTextRef="0" hasNumRef="0">${p}</hp:subList>`
        + `<hp:cellAddr colAddr="${colIdx}" rowAddr="${rowIdx}"/>`
        + `<hp:cellSpan colSpan="1" rowSpan="1"/>`
        + `<hp:cellSz width="${cellW}" height="${cellH}"/>`
        + `<hp:cellMargin left="141" right="141" top="141" bottom="141"/>`
        + `</hp:tc>`
    }).join("")
    return `<hp:tr>${tdElements}</hp:tr>`
  }).join("")

  // <hp:tbl>에 필수 속성 + <hp:sz>/<hp:outMargin>/<hp:inMargin> (pos는 inline-level 기준)
  const tblInner = `<hp:sz width="${tblW}" widthRelTo="ABSOLUTE" height="${tblH}" heightRelTo="ABSOLUTE" protect="0"/>`
    + `<hp:pos treatAsChar="1" affectLSpacing="0" flowWithText="0" allowOverlap="0" holdAnchorAndSO="0" vertRelTo="PARA" horzRelTo="PARA" vertAlign="TOP" horzAlign="LEFT" vertOffset="0" horzOffset="0"/>`
    + `<hp:outMargin left="0" right="0" top="0" bottom="0"/>`
    + `<hp:inMargin left="510" right="510" top="141" bottom="141"/>`
    + trElements

  // 깔보디노는 외곽 테두리 없음(셀별 테두리로 표현) → 표 기본 borderFill=1(무테두리). 기본 표=2(실선)
  const tblBorderFill = kalbodino ? 1 : 2
  const tbl = `<hp:tbl id="${tblId}" zOrder="0" numberingType="TABLE" textWrap="SQUARE" textFlow="BOTH_SIDES" lock="0" dropcapstyle="None" pageBreak="CELL" repeatHeader="0" rowCnt="${rowCnt}" colCnt="${colCnt}" cellSpacing="0" borderFillIDRef="${tblBorderFill}" noShading="0">${tblInner}</hp:tbl>`

  // 테이블은 paragraph 안의 run → 가 아니라 별도 p로 감쌈 (block-level inline-anchored)
  return `<hp:p paraPrIDRef="0" styleIDRef="0"><hp:run charPrIDRef="0">${tbl}</hp:run></hp:p>`
}

// ─── 이미지 생성 ─────────────────────────────────────
//
// 본문 인라인 그림 — <hp:pic>를 paragraph 안의 run에 treatAsChar="1"로 앵커.
// 자식 요소 순서/속성은 한컴이 생성하는 실제 HWPX 구조를 따른다 (렌더 호환 핵심).
// 크기는 이미지 픽셀 → HWPUNIT(96dpi: 1px=75) 환산 후 본문 폭에 맞춰 종횡비 보존 축소.

const IMG_BODY_WIDTH = 47000 // A4 본문 가용 폭(HWPUNIT) 근사 — 표(44000)와 유사 안전값
const PX_TO_HWPUNIT = 75      // 96dpi 기준 1px = 7200/96 HWPUNIT
const IMG_DEFAULT_W = 40000   // 픽셀 크기 미상 시 기본 폭
const IMG_DEFAULT_H = 30000   // 픽셀 크기 미상 시 기본 높이
let picInstIdCounter = 0
function nextPicInstId(): number { return ++picInstIdCounter }

/**
 * 이미지 바이트 → HWPUNIT 크기.
 * - origW/origH: 원본 이미지 전체 크기(px×75). imgClip/imgDim에 사용 (0이면 이미지가 안 보임).
 * - w/h: 본문에 표시할 크기(폭 제한·종횡비 보존). sz/orgSz/imgRect에 사용.
 */
function computeImageSizeHwp(data: Uint8Array): { w: number; h: number; origW: number; origH: number } {
  const px = readImageSize(data)
  if (!px) return { w: IMG_DEFAULT_W, h: IMG_DEFAULT_H, origW: IMG_DEFAULT_W, origH: IMG_DEFAULT_H }
  const origW = Math.round(px.w * PX_TO_HWPUNIT)
  const origH = Math.round(px.h * PX_TO_HWPUNIT)
  let w = origW
  let h = origH
  if (w > IMG_BODY_WIDTH) {
    const scale = IMG_BODY_WIDTH / w
    w = IMG_BODY_WIDTH
    h = Math.round(h * scale)
  }
  return { w, h, origW, origH }
}

/**
 * <hp:pic> 본문 인라인 그림 XML 생성 (paragraph로 감쌈).
 *
 * 구조는 pypandoc-hwpx(검증된 published 변환기)의 hp:pic 방출과 동일하게 맞춘다.
 * 핵심: 바이너리 참조는 `<hc:img>`(hp 아님), 공통 shape 요소(sz/pos/outMargin/shapeComment)는
 * drawing 요소 뒤(맨 끝)에 온다. 이 순서/네임스페이스가 한컴 렌더 호환의 관건.
 */
function generateImage(
  binItemId: string,
  w: number,
  h: number,
  origW: number,
  origH: number,
  alt?: string,
  layout?: ImageLayout,
): string {
  const id = nextPicInstId()
  const instId = 10000000 + id
  const comment = alt ? `<hp:shapeComment>${escapeXml(alt)}</hp:shapeComment>` : `<hp:shapeComment/>`

  // 배치 옵션 → hp:pic textWrap/textFlow + hp:pos treatAsChar/allowOverlap
  const treatAsChar = layout?.treatAsChar !== false // 기본 true(글자처럼)
  const textWrap = treatAsChar ? "TOP_AND_BOTTOM" : (layout?.textWrap || "TOP_AND_BOTTOM")
  const textFlow = layout?.textFlow || "BOTH_SIDES"
  // 글 뒤로/글 앞으로는 본문과 겹치므로 allowOverlap=1. 어울림/자리차지는 0.
  const overlap = !treatAsChar && (textWrap === "BEHIND_TEXT" || textWrap === "IN_FRONT_OF_TEXT") ? 1 : (treatAsChar ? 1 : 0)
  const outMargin = treatAsChar
    ? `<hp:outMargin left="0" right="0" top="0" bottom="0"/>`
    : `<hp:outMargin left="283" right="283" top="283" bottom="283"/>` // 부유 개체는 본문과 간격
  const pos = `<hp:pos treatAsChar="${treatAsChar ? 1 : 0}" affectLSpacing="0" flowWithText="1" allowOverlap="${overlap}" holdAnchorAndSO="0" vertRelTo="PARA" horzRelTo="COLUMN" vertAlign="TOP" horzAlign="LEFT" vertOffset="0" horzOffset="0"/>`

  // imgClip/imgDim는 원본 이미지 전체 영역(HWPUNIT)이어야 함 — 0이면 한컴이 0크기로 잘라 안 보인다.
  const pic =
    `<hp:pic id="${id}" zOrder="0" numberingType="NONE" textWrap="${textWrap}" textFlow="${textFlow}" lock="0" dropcapstyle="None" href="" groupLevel="0" instid="${instId}" reverse="0">` +
      `<hp:offset x="0" y="0"/>` +
      `<hp:orgSz width="${w}" height="${h}"/>` +
      `<hp:curSz width="0" height="0"/>` +
      `<hp:flip horizontal="0" vertical="0"/>` +
      `<hp:rotationInfo angle="0" centerX="0" centerY="0" rotateimage="1"/>` +
      `<hp:renderingInfo>` +
        `<hc:transMatrix e1="1" e2="0" e3="0" e4="0" e5="1" e6="0"/>` +
        `<hc:scaMatrix e1="1" e2="0" e3="0" e4="0" e5="1" e6="0"/>` +
        `<hc:rotMatrix e1="1" e2="0" e3="0" e4="0" e5="1" e6="0"/>` +
      `</hp:renderingInfo>` +
      `<hc:img binaryItemIDRef="${binItemId}" bright="0" contrast="0" effect="REAL_PIC" alpha="0"/>` +
      `<hp:imgRect>` +
        `<hc:pt0 x="0" y="0"/>` +
        `<hc:pt1 x="${w}" y="0"/>` +
        `<hc:pt2 x="${w}" y="${h}"/>` +
        `<hc:pt3 x="0" y="${h}"/>` +
      `</hp:imgRect>` +
      `<hp:imgClip left="0" right="${origW}" top="0" bottom="${origH}"/>` +
      `<hp:inMargin left="0" right="0" top="0" bottom="0"/>` +
      `<hp:imgDim dimwidth="${origW}" dimheight="${origH}"/>` +
      `<hp:effects/>` +
      `<hp:sz width="${w}" widthRelTo="ABSOLUTE" height="${h}" heightRelTo="ABSOLUTE" protect="0"/>` +
      pos +
      outMargin +
      comment +
    `</hp:pic>`
  return `<hp:p paraPrIDRef="0" styleIDRef="0"><hp:run charPrIDRef="0">${pic}</hp:run></hp:p>`
}

/** images 맵에서 src 해결 — 정확 일치 우선, basename 폴백. */
function resolveImageData(
  src: string,
  images?: Map<string, Uint8Array | ArrayBuffer>,
): Uint8Array | null {
  if (!images || !src) return null
  if (images.has(src)) return toU8(images.get(src)!)
  const base = src.split(/[\\/]/).pop() || src
  for (const [k, v] of images) {
    const kbase = k.split(/[\\/]/).pop() || k
    if (kbase === base) return toU8(v)
  }
  return null
}

// ─── 섹션 XML 생성 ──────────────────────────────────

function blocksToSectionXml(
  blocks: MdBlock[],
  theme: ResolvedTheme,
  images?: Map<string, Uint8Array | ArrayBuffer>,
  registry?: EmbeddedImage[],
  imageLayout?: ImageLayout,
  tableBorderFills?: TableBorderFill[],
): string {
  const paraXmls: string[] = []
  let isFirst = true
  // 순서 있는 목록 카운터 — indent 레벨별 별도 유지. 다른 블록 만나면 해당 레벨 리셋.
  const orderedCounters: Record<number, number> = {}
  let prevWasOrdered = false

  for (const block of blocks) {
    let xml = ""

    // 순서 있는 list_item이 아니면 카운터 전부 리셋 (연속되지 않은 목록은 다시 1부터)
    if (block.type !== "list_item" || !block.ordered) {
      if (prevWasOrdered) {
        for (const k of Object.keys(orderedCounters)) delete orderedCounters[+k]
      }
      prevWasOrdered = false
    }

    switch (block.type) {
      case "heading": {
        const pId = headingParaPrId(block.level || 1)
        const cId = headingCharPrId(block.level || 1)
        xml = generateParagraph(block.text || "", pId, cId)
        break
      }
      case "paragraph":
        xml = generateParagraph(block.text || "")
        break
      case "code_block": {
        const codeLines = (block.text || "").split("\n")
        xml = codeLines.map(line => generateParagraph(line || " ", PARA_CODE)).join("\n  ")
        break
      }
      case "blockquote":
        // baseline 호환: quoteColor 옵션 없으면 기존처럼 CHAR_NORMAL (이탤릭 아님)
        xml = generateParagraph(
          block.text || "",
          PARA_QUOTE,
          theme.hasQuoteOption ? CHAR_QUOTE : CHAR_NORMAL,
        )
        break
      case "list_item": {
        const indent = block.indent || 0
        let marker: string
        if (block.ordered) {
          // 러닝 카운터: indent 레벨별로 증가. 하위 레벨(더 깊은 indent)은 별도 세퀀스.
          orderedCounters[indent] = (orderedCounters[indent] || 0) + 1
          // 상위 레벨 번호가 바뀌면 하위는 자동 리셋되어야 함 — 한 레벨 위로 올라갈 때 하위 카운터 초기화
          for (const k of Object.keys(orderedCounters)) {
            if (+k > indent) delete orderedCounters[+k]
          }
          marker = `${orderedCounters[indent]}. `
          prevWasOrdered = true
        } else {
          marker = "· "
          if (prevWasOrdered) {
            for (const k of Object.keys(orderedCounters)) delete orderedCounters[+k]
          }
          prevWasOrdered = false
        }
        const indentPrefix = "  ".repeat(indent)
        xml = generateParagraph(indentPrefix + marker + (block.text || ""), PARA_LIST)
        break
      }
      case "hr":
        // 수평선 — 긴 대시로 대체
        xml = `<hp:p paraPrIDRef="0" styleIDRef="0"><hp:run charPrIDRef="0"><hp:t>────────────────────────────────────────</hp:t></hp:run></hp:p>`
        break
      case "table":
        if (block.rows) {
          if (isFirst) {
            // 테이블이 첫 블록이면 빈 단락에 secPr
            const secRun = `<hp:run charPrIDRef="0">${generateSecPr()}<hp:t></hp:t></hp:run>`
            paraXmls.push(`<hp:p paraPrIDRef="0" styleIDRef="0">${secRun}</hp:p>`)
            isFirst = false
          }
          xml = generateTable(block.rows, theme, images, registry, tableBorderFills)
        }
        break
      case "image": {
        const src = block.src || ""
        const data = resolveImageData(src, images)
        if (data && registry) {
          const { ext, mime } = detectImageType(data)
          const id = `image${registry.length + 1}`
          registry.push({ id, ext, mime, data })
          let { w, h, origW, origH } = computeImageSizeHwp(data)
          // 사용자 지정 폭이 있으면 적용(종횡비 보존, 본문 폭 한계 내).
          if (block.width && origW > 0) {
            w = Math.min(block.width, IMG_BODY_WIDTH)
            h = Math.round(origH * (w / origW))
          }
          // 한컴 실측 hp:pic 구조로 본문 그림 임베드 (imgClip/imgDim=원본 크기, 배치=imageLayout).
          xml = generateImage(id, w, h, origW, origH, block.alt, imageLayout)
        } else {
          // 바이너리 미제공 → 깨진 임베드 대신 자리표시 단락
          xml = generateParagraph(`[그림: ${src}${block.alt ? " — " + block.alt : ""}]`)
        }
        break
      }
    }

    if (!xml) continue

    // 첫 번째 단락에 secPr 주입
    if (isFirst && block.type !== "table") {
      xml = xml.replace(
        /<hp:run charPrIDRef="(\d+)">/,
        `<hp:run charPrIDRef="$1">${generateSecPr()}`
      )
      isFirst = false
    }

    paraXmls.push(xml)
  }

  // 블록이 없으면 빈 단락
  if (paraXmls.length === 0) {
    paraXmls.push(`<hp:p paraPrIDRef="0" styleIDRef="0"><hp:run charPrIDRef="0">${generateSecPr()}<hp:t></hp:t></hp:run></hp:p>`)
  }

  return `<?xml version="1.0" encoding="UTF-8" standalone="yes" ?>
<hs:sec xmlns:hs="${NS_SECTION}" xmlns:hp="${NS_PARA}" xmlns:hc="${NS_CORE}">
  ${paraXmls.join("\n  ")}
</hs:sec>`
}

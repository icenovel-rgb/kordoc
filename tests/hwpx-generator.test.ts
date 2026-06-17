/** HWPX 역변환 (generator) 테스트 — 라운드트립 검증 */

import { describe, it } from "node:test"
import assert from "node:assert/strict"
import JSZip from "jszip"
import { markdownToHwpx } from "../src/hwpx/generator.js"
import { parse } from "../src/index.js"

describe("markdownToHwpx", () => {
  it("단순 텍스트 → HWPX → 라운드트립", async () => {
    const md = "대한민국 헌법 제1조"
    const hwpxBuf = await markdownToHwpx(md)

    assert.ok(hwpxBuf instanceof ArrayBuffer, "ArrayBuffer 반환")
    assert.ok(hwpxBuf.byteLength > 0, "비어있지 않음")

    // 라운드트립: 생성된 HWPX를 다시 파싱
    const result = await parse(hwpxBuf)
    assert.equal(result.success, true, `파싱 실패: ${result.success === false ? result.error : ""}`)
    if (result.success) {
      assert.ok(result.markdown.includes("대한민국 헌법 제1조"), "원본 텍스트 보존")
    }
  })

  it("멀티 단락 → 라운드트립", async () => {
    const md = "첫 번째 단락\n\n두 번째 단락\n\n세 번째 단락"
    const hwpxBuf = await markdownToHwpx(md)
    const result = await parse(hwpxBuf)

    assert.equal(result.success, true)
    if (result.success) {
      assert.ok(result.markdown.includes("첫 번째 단락"))
      assert.ok(result.markdown.includes("두 번째 단락"))
      assert.ok(result.markdown.includes("세 번째 단락"))
    }
  })

  it("테이블 → HWPX → 라운드트립", async () => {
    const md = "| 이름 | 직급 |\n| --- | --- |\n| 홍길동 | 과장 |"
    const hwpxBuf = await markdownToHwpx(md)
    const result = await parse(hwpxBuf)

    assert.equal(result.success, true)
    if (result.success) {
      assert.ok(result.markdown.includes("이름"), "헤더 보존")
      assert.ok(result.markdown.includes("홍길동"), "데이터 보존")
      // table 블록 존재
      assert.ok(result.blocks.some(b => b.type === "table"), "테이블 블록 존재")
    }
  })

  it("헤딩 + 본문 혼합", async () => {
    const md = "# 제1장 총강\n\n대한민국은 민주공화국이다.\n\n# 제2장 권리\n\n모든 국민은 법 앞에 평등하다."
    const hwpxBuf = await markdownToHwpx(md)
    const result = await parse(hwpxBuf)

    assert.equal(result.success, true)
    if (result.success) {
      assert.ok(result.markdown.includes("제1장 총강"))
      assert.ok(result.markdown.includes("민주공화국"))
      assert.ok(result.markdown.includes("제2장 권리"))
    }
  })

  it("빈 마크다운 → 유효한 HWPX (빈 내용)", async () => {
    const hwpxBuf = await markdownToHwpx("")
    assert.ok(hwpxBuf.byteLength > 0, "ZIP은 생성됨")

    const result = await parse(hwpxBuf)
    // 빈 섹션이면 파싱은 성공하지만 내용 없음
    assert.equal(result.success, true)
  })

  it("특수문자 XML 이스케이프", async () => {
    const md = "A < B & C > D \"E\""
    const hwpxBuf = await markdownToHwpx(md)
    const result = await parse(hwpxBuf)

    assert.equal(result.success, true)
    if (result.success) {
      assert.ok(result.markdown.includes("A < B"), "< 보존")
      assert.ok(result.markdown.includes("& C"), "& 보존")
    }
  })

  // ─── 이미지 임베드 ───────────────────────────────────
  // 1×1 빨강 PNG (실제 바이트)
  const RED_PNG = Uint8Array.from(Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
    "base64",
  ))

  it("이미지 임베드 → BinData + manifest + hp:pic(hc:img)", async () => {
    const md = "# 제목\n\n![빨강](images/fig1.png)\n\n본문"
    const images = new Map([["images/fig1.png", RED_PNG]])
    const hwpxBuf = await markdownToHwpx(md, { images })
    const zip = await JSZip.loadAsync(new Uint8Array(hwpxBuf))

    // BinData 바이너리 원본 동일
    const bin = await zip.file("BinData/image1.png")!.async("uint8array")
    assert.equal(bin.length, RED_PNG.length, "BinData 길이 동일")
    assert.equal(bin[0], RED_PNG[0], "BinData 첫 바이트 동일")

    // manifest 이미지 item
    const hpf = await zip.file("Contents/content.hpf")!.async("string")
    assert.match(hpf, /id="image1"[^>]*href="BinData\/image1\.png"[^>]*media-type="image\/png"/, "manifest 이미지 item")

    // section0.xml: hp:pic + hc:img(binaryItemIDRef) — pypandoc-hwpx 검증 구조
    const sec = await zip.file("Contents/section0.xml")!.async("string")
    assert.ok(sec.includes("<hp:pic"), "hp:pic 존재")
    assert.match(sec, /<hc:img binaryItemIDRef="image1"/, "hc:img binaryItemIDRef 일치")
  })

  it("이미지 임베드 → 라운드트립 (parse가 이미지 블록 복원)", async () => {
    const md = "본문\n\n![설명](fig.png)\n"
    const images = new Map([["fig.png", RED_PNG]])
    const hwpxBuf = await markdownToHwpx(md, { images })
    const result = await parse(hwpxBuf)

    assert.equal(result.success, true)
    if (result.success) {
      assert.match(result.markdown, /!\[[^\]]*\]\([^)]+\)/, "이미지 마크다운 복원")
    }
  })

  it("바이너리 미제공 이미지 → 자리표시 단락 (깨진 임베드 방지)", async () => {
    const md = "![누락된 그림](missing.png)"
    const hwpxBuf = await markdownToHwpx(md)
    const zip = await JSZip.loadAsync(new Uint8Array(hwpxBuf))
    const sec = await zip.file("Contents/section0.xml")!.async("string")
    assert.ok(!sec.includes("<hp:pic"), "hp:pic 없음")
    assert.ok(sec.includes("[그림: missing.png"), "자리표시 텍스트")

    const result = await parse(hwpxBuf)
    assert.equal(result.success, true)
  })

  it("basename 폴백 — 경로 달라도 파일명 일치 시 임베드", async () => {
    const md = "![x](assets/sub/photo.png)"
    const images = new Map([["photo.png", RED_PNG]])
    const hwpxBuf = await markdownToHwpx(md, { images })
    const zip = await JSZip.loadAsync(new Uint8Array(hwpxBuf))
    assert.ok(zip.file("BinData/image1.png"), "basename 폴백으로 임베드됨")
  })

  it("JPEG 매직바이트 → .jpg 확장자/ media-type", async () => {
    // 최소 JPEG 헤더 (SOI + APP0 + SOF0 8×8) — 크기 판별용
    const jpg = Uint8Array.from([
      0xff,0xd8,0xff,0xe0,0x00,0x10,0x4a,0x46,0x49,0x46,0x00,0x01,0x01,0x00,0x00,0x01,
      0x00,0x01,0x00,0x00,0xff,0xc0,0x00,0x11,0x08,0x00,0x08,0x00,0x08,0x03,0x01,0x22,
      0x00,0x02,0x11,0x01,0x03,0x11,0x01,0xff,0xd9,
    ])
    const md = "![j](p.jpg)"
    const hwpxBuf = await markdownToHwpx(md, { images: new Map([["p.jpg", jpg]]) })
    const zip = await JSZip.loadAsync(new Uint8Array(hwpxBuf))
    assert.ok(zip.file("BinData/image1.jpg"), "jpg 확장자")
    const hpf = await zip.file("Contents/content.hpf")!.async("string")
    assert.match(hpf, /media-type="image\/jpeg"/, "jpeg media-type")
  })

  // ─── 디자인 테마 (깔보디노) ──────────────────────────
  it("bodyLineSpacing 테마 → 본문 paraPr 행간 반영, 기본은 160", async () => {
    const def = await markdownToHwpx("본문")
    const zd = await JSZip.loadAsync(new Uint8Array(def))
    const hd = await zd.file("Contents/header.xml")!.async("string")
    assert.match(hd, /paraPr id="0"[\s\S]*?lineSpacing type="PERCENT" value="160"/, "기본 160")

    const buf = await markdownToHwpx("본문", { theme: { bodyLineSpacing: 180 } })
    const z = await JSZip.loadAsync(new Uint8Array(buf))
    const h = await z.file("Contents/header.xml")!.async("string")
    assert.match(h, /paraPr id="0"[\s\S]*?lineSpacing type="PERCENT" value="180"/, "180 반영")
    assert.equal((await parse(buf)).success, true)
  })

  it("kalbodino 표 스타일 → 위치별 borderFill + 머리행 배경", async () => {
    const md = "| A | B |\n| - | - |\n| 1 | 2 |\n| 3 | 4 |"
    const buf = await markdownToHwpx(md, { theme: { tableStyle: "kalbodino", tableCellLineSpacing: 130 } })
    const z = await JSZip.loadAsync(new Uint8Array(buf))
    const h = await z.file("Contents/header.xml")!.async("string")
    const s = await z.file("Contents/section0.xml")!.async("string")
    assert.match(h, /faceColor="#4A6672"/, "머리행 배경색(기본)")
    assert.match(h, /type="DASH"/, "세로 점선")
    assert.match(h, /width="0\.4 mm"/, "머리/하단 굵은선")
    assert.match(h, /paraPr id="8"[\s\S]*?value="130"/, "셀 행간 130")
    // 머리행 셀은 BF_TABLE_BASE(2) 이상의 동적 borderFill 참조
    assert.ok(/borderFillIDRef="[2-9]\d*"/.test(s), "동적 borderFill 참조")
    assert.equal((await parse(buf)).success, true)
  })

  it("기본 표 스타일은 그대로(borderFill 2개, 1-기반)", async () => {
    const md = "| A | B |\n| - | - |\n| 1 | 2 |"
    const buf = await markdownToHwpx(md)
    const z = await JSZip.loadAsync(new Uint8Array(buf))
    const h = await z.file("Contents/header.xml")!.async("string")
    assert.match(h, /borderFills itemCnt="2"/, "기본은 borderFill 2개")
    assert.ok(!/borderFill id="0"/.test(h), "borderFill id=0 없음(1-기반)")
    assert.match(h, /borderFill id="1"/, "id=1부터 시작")
  })

  it("borderFill id는 항상 1-기반(id=0 금지) — 채움 밀림 방지", async () => {
    // 깔보디노 표에서도 id=0이 없어야 한컴이 채움을 올바른 셀에 렌더한다.
    const md = "| A | B |\n| - | - |\n| 1 | 2 |"
    const buf = await markdownToHwpx(md, { theme: { tableStyle: "kalbodino" } })
    const z = await JSZip.loadAsync(new Uint8Array(buf))
    const h = await z.file("Contents/header.xml")!.async("string")
    assert.ok(!/borderFill id="0"/.test(h), "id=0 없음")
    // 채움 borderFill의 id가 머리행 셀 borderFillIDRef와 일치
    const s = await z.file("Contents/section0.xml")!.async("string")
    const firstRow = s.match(/<hp:tr>[\s\S]*?<\/hp:tr>/)![0]
    const headRefs = (firstRow.match(/borderFillIDRef="(\d+)"/g) || []).map(x => x.match(/\d+/)![0])
    for (const ref of headRefs) {
      const bf = h.match(new RegExp(`<hh:borderFill id="${ref}"[\\s\\S]*?</hh:borderFill>`))![0]
      assert.match(bf, /faceColor="#4A6672"/, `머리행 셀(id ${ref})에 채움`)
    }
  })

  it("이미지 크기 지정 {width=Ncm/%} 적용", async () => {
    const buf = await markdownToHwpx("![x](f.png){width=8cm}", { images: new Map([["f.png", RED_PNG]]) })
    const z = await JSZip.loadAsync(new Uint8Array(buf))
    const s = await z.file("Contents/section0.xml")!.async("string")
    const w = Number(s.match(/<hp:pic[\s\S]*?<hp:sz width="(\d+)"/)![1])
    // 8cm ≈ 22677 HWPUNIT (±2 반올림 허용)
    assert.ok(Math.abs(w - 22677) <= 3, `8cm 표시폭 적용 (got ${w})`)
  })

  it("이미지 배치 옵션 → textWrap/treatAsChar 반영", async () => {
    const png = RED_PNG
    const buf = await markdownToHwpx("![x](f.png)", {
      images: new Map([["f.png", png]]),
      imageLayout: { treatAsChar: false, textWrap: "SQUARE", textFlow: "BOTH_SIDES" },
    })
    const z = await JSZip.loadAsync(new Uint8Array(buf))
    const s = await z.file("Contents/section0.xml")!.async("string")
    assert.match(s, /textWrap="SQUARE"/, "textWrap 반영")
    assert.match(s, /treatAsChar="0"/, "부유 개체")
  })

  it("표 셀 안 이미지 → 셀에 hp:pic 임베드", async () => {
    const md = "| 그림 |\n| --- |\n| ![c](f.png) |"
    const buf = await markdownToHwpx(md, { images: new Map([["f.png", RED_PNG]]) })
    const z = await JSZip.loadAsync(new Uint8Array(buf))
    const s = await z.file("Contents/section0.xml")!.async("string")
    assert.ok(s.includes("<hp:tbl"), "표 존재")
    assert.ok(s.includes("<hp:pic"), "셀 안 hp:pic")
    assert.ok(z.file("BinData/image1.png"), "BinData 임베드")
  })
})

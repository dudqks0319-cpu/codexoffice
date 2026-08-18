#!/usr/bin/env python3
"""Generate deterministic portfolio XLSX/PPTX sources for CodexOffice QA.

The files are generated offline, then the real CodexOffice shell applies its
own edits/themes and registers them in the canonical project store.
"""

from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path

from openpyxl import Workbook
from openpyxl.chart import BarChart, Reference
from openpyxl.formatting.rule import ColorScaleRule
from openpyxl.styles import Alignment, Border, Font, PatternFill, Side
from openpyxl.worksheet.datavalidation import DataValidation
from openpyxl.worksheet.table import Table, TableStyleInfo
from pptx import Presentation
from pptx.dml.color import RGBColor
from pptx.enum.shapes import MSO_CONNECTOR, MSO_SHAPE
from pptx.enum.text import MSO_ANCHOR, PP_ALIGN
from pptx.util import Inches, Pt


APPS = [
    {
        "slug": "codexoffice",
        "project": "CodexOffice 출시 브리프",
        "title": "CodexOffice",
        "subtitle": "문서·시트·슬라이드·PDF를 하나의 안전한 작업 흐름으로",
        "stage": "출시 전 검증",
        "theme": "Indigo",
        "accent": "18A8C9",
        "accent2": "5E6AD2",
        "dark": "101828",
        "light": "E9F8FB",
        "problems": [
            "오피스 편집과 AI 작업이 서로 분리돼 맥락이 끊긴다",
            "가져온 OOXML을 저장할 때 원본 충실도가 쉽게 무너진다",
            "출시 증거와 로컬 PASS가 섞이면 배포 판단이 흐려진다",
        ],
        "flow": ["파일 열기", "좁은 범위 편집", "AI 제안 검토", "원본 보존 저장", "재열기 검증"],
        "evidence": [
            ("JS/TS 테스트", "3,841", "현재 로컬 검증"),
            ("Electron E2E", "15/15", "실제 앱·정상 종료"),
            ("온라인 감사", "0", "승인된 npm 감사"),
            ("LibreOffice", "3/3", "구조 round-trip"),
        ],
        "roadmap": [
            ("P0", "정확한 source SHA와 깨끗한 후보", "HOLD", "출시 담당", "출시 전"),
            ("P0", "Word·Excel·PowerPoint 수동 호환성", "HOLD", "호환성 담당", "출시 전"),
            ("P0", "Developer ID 서명·공증·staple", "HOLD", "출시 담당", "출시 전"),
            ("P1", "HTTPS N→N+1 업데이트 검증", "계획", "출시 담당", "서명 후"),
            ("P1", "PDF 메모리 상한 플랫폼 강화", "계획", "PDF 담당", "다음 후보"),
        ],
        "scores": [("제품 명확성", 94), ("편집 완성도", 88), ("보안 경계", 91), ("출시 증거", 72)],
        "decision": "로컬 기능은 유지하고, 외부 출시 증거가 모두 묶인 단일 후보만 배포한다.",
        "ask": "Microsoft Office QA 환경 + Developer ID + HTTPS 업데이트 채널",
    },
    {
        "slug": "jipbabnote",
        "project": "JipbabNote 제품 브리프",
        "title": "JipbabNote · 집밥노트",
        "subtitle": "냉장고 재료에서 오늘의 집밥과 장보기까지 이어지는 모바일 도우미",
        "stage": "1.0.1 후보 QA",
        "theme": "Rose",
        "accent": "F05A67",
        "accent2": "3E8E7E",
        "dark": "312A2E",
        "light": "FFF0F1",
        "problems": [
            "보유 재료와 오늘 먹을 메뉴가 연결되지 않는다",
            "유통기한 임박 재료가 냉장고 안에서 잊힌다",
            "레시피 확인 뒤 부족 재료를 다시 장보기로 옮겨야 한다",
        ],
        "flow": ["재료 등록", "임박 재료 확인", "레시피 추천", "부족 재료 계산", "장보기 연결"],
        "evidence": [
            ("공개 버전", "1.0", "READY_FOR_SALE 원장"),
            ("현재 후보", "1.0.1", "제출 준비 단계"),
            ("필수 실기기 QA", "4/6", "저장된 후보 원장"),
            ("핵심 사용자 흐름", "5단계", "냉장고→장보기"),
        ],
        "roadmap": [
            ("P0", "Apple·Kakao 최종 인증 시나리오", "HOLD", "모바일 QA", "제출 전"),
            ("P0", "disposable account 실제 삭제", "HOLD", "모바일 QA", "제출 전"),
            ("P0", "DB migration·원격 schema 정합성", "진행 중", "백엔드", "후보 고정 전"),
            ("P1", "사람 레시피·이미지 권리 검수", "계획", "콘텐츠", "공개 확대 전"),
            ("P2", "Android·Play Console 준비", "계획", "모바일", "iOS 안정 후"),
        ],
        "scores": [("문제 명확성", 93), ("핵심 흐름", 89), ("데이터 안전", 82), ("후보 출시 증거", 67)],
        "decision": "1.0.1은 남은 2개 실기기 시나리오와 데이터 정합성 증거 전까지 제출하지 않는다.",
        "ask": "실기기 인증 QA + disposable 계정 + 원격 migration 검증 권한",
    },
    {
        "slug": "projectburrow",
        "project": "ProjectBurrow 운영 브리프",
        "title": "ProjectBurrow · CalmGauge",
        "subtitle": "Mac 상태를 조용히 보여주고, 정리는 반드시 확인 뒤 실행하는 안전 우선 도구",
        "stage": "출시 증거 수집",
        "theme": "Forest",
        "accent": "2BB7A9",
        "accent2": "4A7BEA",
        "dark": "0E1D2B",
        "light": "EAF8F6",
        "problems": [
            "저장공간·메모리 상태는 보이지만 안전한 다음 행동이 불명확하다",
            "정리 앱이 보호 파일과 실행 중 앱을 건드릴 위험이 있다",
            "로컬 테스트와 실제 Mac 장기 증거가 쉽게 혼동된다",
        ],
        "flow": ["상태 관찰", "읽기 전용 스캔", "후보 검증", "사용자 재확인", "휴지통·기록"],
        "evidence": [
            ("저장된 테스트", "218/218", "이전 exact clean source"),
            ("실제 Mac 관찰", "30분", "저장된 M3 Max 증거"),
            ("파괴적 UI", "잠금", "Safety Core 전 미연결"),
            ("최신 출시 판정", "HOLD", "exact-source QA 필요"),
        ],
        "roadmap": [
            ("P0", "최신 source 전체 회귀·Analyze", "HOLD", "macOS QA", "후보 고정 전"),
            ("P0", "실제 보호 앱·미저장 문서 QA", "HOLD", "안전 QA", "출시 전"),
            ("P0", "24시간 runtime·sleep/wake 증거", "진행 중", "성능 QA", "출시 전"),
            ("P0", "Developer ID·공증·깨끗한 Mac", "HOLD", "출시 담당", "배포 전"),
            ("P1", "브랜드·상표·도메인 확인", "계획", "브랜드", "공개 전"),
        ],
        "scores": [("안전 정책", 95), ("읽기 전용 분석", 90), ("성능 근거", 74), ("출시 증거", 58)],
        "decision": "Safety Core와 실제 Mac 증거가 같은 exact source에 묶이기 전에는 배포 후보로 승격하지 않는다.",
        "ask": "최신 clean build + 실제 Mac 장기 QA + Developer ID/공증 환경",
    },
]


def rgb(value: str) -> RGBColor:
    return RGBColor.from_string(value)


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def style_cell(cell, *, fill=None, color="101828", bold=False, size=11, align="left"):
    if fill:
        cell.fill = PatternFill("solid", fgColor=fill)
    cell.font = Font(name="Apple SD Gothic Neo", size=size, bold=bold, color=color)
    cell.alignment = Alignment(horizontal=align, vertical="center", wrap_text=True)


def make_workbook(app: dict, path: Path) -> None:
    wb = Workbook()
    wb.properties.creator = "CodexOffice Sheets"
    wb.properties.title = f"{app['title']} 제품 브리프"
    wb.properties.subject = "CodexOffice portfolio showcase"
    wb.properties.description = "Local source-bound planning artifact; targets are not actual performance claims."

    overview = wb.active
    overview.title = "한눈에 보기"
    overview.sheet_view.showGridLines = False
    overview.freeze_panes = "A12"
    for col, width in {"A": 18, "B": 25, "C": 3, "D": 18, "E": 18, "F": 18, "G": 18, "H": 18, "I": 18, "J": 18}.items():
        overview.column_dimensions[col].width = width
    overview.row_dimensions[1].height = 34
    overview.row_dimensions[2].height = 28
    overview.merge_cells("A1:J1")
    overview["A1"] = app["title"]
    style_cell(overview["A1"], fill=app["dark"], color="FFFFFF", bold=True, size=24)
    overview.merge_cells("A2:J2")
    overview["A2"] = app["subtitle"]
    style_cell(overview["A2"], fill=app["light"], color=app["dark"], size=12)
    overview["A4"] = "제작 도구"
    overview["B4"] = "CodexOffice Sheets"
    overview["D4"] = "현재 단계"
    overview["E4"] = app["stage"]
    overview["G4"] = "자료 기준"
    overview["H4"] = "2026-08-13 로컬 원장"
    for coordinate in ["A4", "D4", "G4"]:
        style_cell(overview[coordinate], fill="E4E7EC", bold=True)
    for coordinate in ["B4", "E4", "H4"]:
        style_cell(overview[coordinate], fill="FFFFFF")

    overview.merge_cells("A6:J7")
    overview["A6"] = app["decision"]
    style_cell(overview["A6"], fill=app["light"], color=app["dark"], bold=True, size=15, align="center")

    overview["A9"] = "검증 지표"
    style_cell(overview["A9"], fill=app["dark"], color="FFFFFF", bold=True, size=12)
    for index, (label, value, note) in enumerate(app["evidence"], start=0):
        col = 1 + index * 2
        overview.cell(9, col + 1, label)
        overview.cell(10, col + 1, value)
        overview.cell(11, col + 1, note)
        style_cell(overview.cell(9, col + 1), fill=app["accent"], color="FFFFFF", bold=True, align="center")
        style_cell(overview.cell(10, col + 1), fill="FFFFFF", color=app["dark"], bold=True, size=20, align="center")
        style_cell(overview.cell(11, col + 1), fill=app["light"], color="475467", size=9, align="center")

    headers = ["구분", "내용", "상태", "근거"]
    for col, value in enumerate(headers, start=1):
        overview.cell(13, col, value)
        style_cell(overview.cell(13, col), fill=app["dark"], color="FFFFFF", bold=True, align="center")
    capability_rows = [
        ("핵심 문제", app["problems"][0], "확인", "현재 README/원장"),
        ("핵심 흐름", " → ".join(app["flow"]), "정의", "제품 흐름"),
        ("현재 단계", app["stage"], "진행 중", "현재 원장"),
        ("의사결정", app["decision"], "유지", "출시 경계"),
        ("필요 지원", app["ask"], "HOLD", "외부 증거"),
    ]
    for row_index, row in enumerate(capability_rows, start=14):
        for col, value in enumerate(row, start=1):
            overview.cell(row_index, col, value)
            style_cell(overview.cell(row_index, col), fill="FFFFFF" if row_index % 2 == 0 else "F8FAFC")
    overview.auto_filter.ref = "A13:D18"
    overview.print_area = "A1:J18"
    overview.sheet_properties.pageSetUpPr.fitToPage = True
    overview.page_setup.fitToWidth = 1
    overview.page_setup.fitToHeight = 1
    overview.oddFooter.center.text = "CodexOffice Portfolio Showcase · &[Page]/&[Pages]"

    roadmap = wb.create_sheet("로드맵")
    roadmap.sheet_view.showGridLines = False
    roadmap.freeze_panes = "A5"
    roadmap.merge_cells("A1:G1")
    roadmap["A1"] = f"{app['title']} 실행 로드맵"
    style_cell(roadmap["A1"], fill=app["dark"], color="FFFFFF", bold=True, size=20)
    roadmap["A3"] = "완료율"
    roadmap["B3"] = '=COUNTIF(C5:C9,"완료")/COUNTA(C5:C9)'
    roadmap["B3"].number_format = "0%"
    roadmap["D3"] = "HOLD 수"
    roadmap["E3"] = '=COUNTIF(C5:C9,"HOLD")'
    for coordinate in ["A3", "D3"]:
        style_cell(roadmap[coordinate], fill="E4E7EC", bold=True)
    for coordinate in ["B3", "E3"]:
        style_cell(roadmap[coordinate], fill=app["light"], color=app["dark"], bold=True, size=14, align="center")
    roadmap_headers = ["우선순위", "핵심 과제", "상태", "담당", "기한", "증거 기준", "완료 점수"]
    for col, value in enumerate(roadmap_headers, start=1):
        roadmap.cell(4, col, value)
        style_cell(roadmap.cell(4, col), fill=app["dark"], color="FFFFFF", bold=True, align="center")
    statuses = {"완료": 100, "진행 중": 60, "HOLD": 25, "계획": 10}
    for row_index, (priority, task, status, owner, due) in enumerate(app["roadmap"], start=5):
        values = [priority, task, status, owner, due, "exact source + 재현 가능한 증거", statuses[status]]
        for col, value in enumerate(values, start=1):
            roadmap.cell(row_index, col, value)
            style_cell(roadmap.cell(row_index, col), fill="FFFFFF" if row_index % 2 else "F8FAFC")
        roadmap.cell(row_index, 7).number_format = '0"점"'
    status_validation = DataValidation(type="list", formula1='"완료,진행 중,HOLD,계획"', allow_blank=False)
    roadmap.add_data_validation(status_validation)
    status_validation.add("C5:C9")
    roadmap.conditional_formatting.add(
        "G5:G9",
        ColorScaleRule(start_type="num", start_value=0, start_color="FEE4E2", mid_type="num", mid_value=60, mid_color="FEF0C7", end_type="num", end_value=100, end_color="D1FADF"),
    )
    table = Table(displayName=f"Roadmap_{app['slug']}", ref="A4:G9")
    table.tableStyleInfo = TableStyleInfo(name="TableStyleMedium2", showRowStripes=True, showFirstColumn=False, showLastColumn=False)
    roadmap.add_table(table)
    for col, width in {"A": 12, "B": 38, "C": 14, "D": 16, "E": 16, "F": 34, "G": 13}.items():
        roadmap.column_dimensions[col].width = width
    roadmap.print_area = "A1:G9"
    roadmap.sheet_properties.pageSetUpPr.fitToPage = True
    roadmap.page_setup.orientation = "landscape"
    roadmap.page_setup.fitToWidth = 1
    roadmap.page_setup.fitToHeight = 1

    metrics = wb.create_sheet("지표")
    metrics.sheet_view.showGridLines = False
    metrics.merge_cells("A1:F1")
    metrics["A1"] = f"{app['title']} 내부 기획 지표"
    style_cell(metrics["A1"], fill=app["dark"], color="FFFFFF", bold=True, size=20)
    metrics.merge_cells("A2:F2")
    metrics["A2"] = "아래 점수는 우선순위 비교용 내부 기획 점수이며 실제 시장 성과가 아닙니다."
    style_cell(metrics["A2"], fill="FFF7ED", color="9A3412", bold=True, size=10)
    metric_headers = ["영역", "내부 기획 점수", "기준", "상태"]
    for col, value in enumerate(metric_headers, start=1):
        metrics.cell(4, col, value)
        style_cell(metrics.cell(4, col), fill=app["dark"], color="FFFFFF", bold=True, align="center")
    for row_index, (label, score) in enumerate(app["scores"], start=5):
        values = [label, score, "0–100 내부 비교", "목표/검토"]
        for col, value in enumerate(values, start=1):
            metrics.cell(row_index, col, value)
            style_cell(metrics.cell(row_index, col), fill="FFFFFF" if row_index % 2 else "F8FAFC")
    metrics["A11"] = "평균"
    metrics["B11"] = "=AVERAGE(B5:B8)"
    metrics["B11"].number_format = '0.0"점"'
    style_cell(metrics["A11"], fill="E4E7EC", bold=True)
    style_cell(metrics["B11"], fill=app["light"], color=app["dark"], bold=True, size=14, align="center")
    metrics.conditional_formatting.add(
        "B5:B8",
        ColorScaleRule(start_type="num", start_value=0, start_color="FEE4E2", mid_type="num", mid_value=70, mid_color="FEF0C7", end_type="num", end_value=100, end_color="D1FADF"),
    )
    chart = BarChart()
    chart.type = "bar"
    chart.style = 10
    chart.title = "내부 기획 점수"
    chart.y_axis.title = "영역"
    chart.x_axis.title = "점수"
    chart.height = 7.2
    chart.width = 12.5
    chart.add_data(Reference(metrics, min_col=2, min_row=4, max_row=8), titles_from_data=True)
    chart.set_categories(Reference(metrics, min_col=1, min_row=5, max_row=8))
    chart.legend = None
    metrics.add_chart(chart, "F4")
    for col, width in {"A": 22, "B": 18, "C": 22, "D": 18, "E": 3, "F": 16}.items():
        metrics.column_dimensions[col].width = width
    metrics.freeze_panes = "A5"

    thin = Side(style="thin", color="D0D5DD")
    for sheet in wb.worksheets:
        for row in sheet.iter_rows():
            for cell in row:
                if cell.value is not None:
                    cell.border = Border(bottom=thin)
        sheet.oddFooter.right.text = "2026-08-13"
    wb.save(path)


def add_text(slide, text, x, y, w, h, *, size=24, color="101828", bold=False, align=PP_ALIGN.LEFT, font="Arial"):
    box = slide.shapes.add_textbox(Inches(x), Inches(y), Inches(w), Inches(h))
    frame = box.text_frame
    frame.clear()
    frame.word_wrap = True
    frame.vertical_anchor = MSO_ANCHOR.MIDDLE
    paragraph = frame.paragraphs[0]
    paragraph.text = text
    paragraph.alignment = align
    paragraph.font.name = font
    paragraph.font.size = Pt(size)
    paragraph.font.bold = bold
    paragraph.font.color.rgb = rgb(color)
    return box


def add_rect(slide, x, y, w, h, *, fill, radius=True, line=None):
    shape = slide.shapes.add_shape(
        MSO_SHAPE.ROUNDED_RECTANGLE if radius else MSO_SHAPE.RECTANGLE,
        Inches(x), Inches(y), Inches(w), Inches(h),
    )
    shape.fill.solid()
    shape.fill.fore_color.rgb = rgb(fill)
    if line:
        shape.line.color.rgb = rgb(line)
        shape.line.width = Pt(1)
    else:
        shape.line.fill.background()
    return shape


def add_footer(slide, app: dict, index: int, dark=False):
    color = "D0D5DD" if dark else "667085"
    add_text(slide, "CodexOffice Portfolio Showcase · 2026.08.13", 0.55, 7.05, 5.8, 0.22, size=8, color=color)
    add_text(slide, f"{index:02d}", 12.2, 7.05, 0.55, 0.22, size=8, color=color, align=PP_ALIGN.RIGHT)


def set_background(slide, color: str):
    fill = slide.background.fill
    fill.solid()
    fill.fore_color.rgb = rgb(color)


def make_presentation(app: dict, path: Path) -> None:
    prs = Presentation()
    prs.slide_width = Inches(13.333)
    prs.slide_height = Inches(7.5)
    blank = prs.slide_layouts[6]
    prs.core_properties.author = "CodexOffice Slides"
    prs.core_properties.title = f"{app['title']} 발표자료"
    prs.core_properties.subject = "CodexOffice portfolio showcase"

    # 1 — title
    slide = prs.slides.add_slide(blank)
    set_background(slide, "FFFFFF")
    add_rect(slide, 0.65, 0.62, 2.35, 0.42, fill=app["accent"])
    add_text(slide, "PRODUCT BRIEF", 0.78, 0.68, 2.1, 0.26, size=11, color=app["dark"], bold=True)
    add_text(slide, app["title"], 0.7, 1.55, 11.8, 1.0, size=34, color=app["dark"], bold=True)
    add_text(slide, app["subtitle"], 0.72, 2.62, 10.8, 0.82, size=18, color="475467")
    chips = [app["stage"], "근거 기반", "CodexOffice 제작"]
    for idx, chip in enumerate(chips):
        add_rect(slide, 0.72 + idx * 2.25, 4.35, 2.0, 0.54, fill=app["light"], line=app["accent"])
        add_text(slide, chip, 0.82 + idx * 2.25, 4.43, 1.8, 0.32, size=11, color=app["dark"], bold=True, align=PP_ALIGN.CENTER)
    add_text(slide, app["decision"], 0.72, 5.45, 11.5, 0.72, size=15, color=app["dark"], bold=True)
    add_footer(slide, app, 1)

    # 2 — problem
    slide = prs.slides.add_slide(blank)
    set_background(slide, "FFFFFF")
    add_text(slide, "01 · 해결하려는 문제", 0.65, 0.45, 7.4, 0.48, size=24, color=app["dark"], bold=True)
    add_text(slide, "기능 목록보다 사용자가 멈추는 지점을 먼저 봅니다.", 0.68, 0.98, 9.8, 0.36, size=12, color="667085")
    for idx, problem in enumerate(app["problems"]):
        x = 0.68 + idx * 4.15
        add_rect(slide, x, 1.72, 3.7, 3.65, fill="F8FAFC", line="E4E7EC")
        add_rect(slide, x + 0.25, 2.02, 0.58, 0.58, fill=app["accent"])
        add_text(slide, str(idx + 1), x + 0.25, 2.07, 0.58, 0.35, size=15, color="FFFFFF", bold=True, align=PP_ALIGN.CENTER)
        add_text(slide, problem, x + 0.25, 2.82, 3.18, 1.25, size=17, color=app["dark"], bold=True)
        add_text(slide, "관찰 → 범위 정의 → 검증 가능한 다음 행동", x + 0.25, 4.48, 3.05, 0.5, size=10, color="667085")
    add_footer(slide, app, 2)

    # 3 — flow
    slide = prs.slides.add_slide(blank)
    set_background(slide, app["light"])
    add_text(slide, "02 · 핵심 사용자 흐름", 0.65, 0.45, 7.4, 0.48, size=24, color=app["dark"], bold=True)
    add_text(slide, "한 화면의 기능보다 앞뒤 단계가 자연스럽게 이어지는지를 기준으로 설계합니다.", 0.68, 0.98, 10.8, 0.36, size=12, color="475467")
    step_w = 2.15
    gap = 0.36
    for idx, step in enumerate(app["flow"]):
        x = 0.58 + idx * (step_w + gap)
        add_rect(slide, x, 2.3, step_w, 2.25, fill="FFFFFF", line="D0D5DD")
        add_text(slide, f"STEP {idx + 1}", x + 0.18, 2.58, step_w - 0.36, 0.32, size=10, color=app["accent"], bold=True)
        add_text(slide, step, x + 0.18, 3.12, step_w - 0.36, 0.75, size=16, color=app["dark"], bold=True, align=PP_ALIGN.CENTER)
        if idx < len(app["flow"]) - 1:
            line = slide.shapes.add_connector(MSO_CONNECTOR.STRAIGHT, Inches(x + step_w), Inches(3.42), Inches(x + step_w + gap), Inches(3.42))
            line.line.color.rgb = rgb(app["accent"])
            line.line.width = Pt(2)
    add_rect(slide, 0.72, 5.25, 11.88, 0.78, fill=app["dark"])
    add_text(slide, app["decision"], 0.98, 5.39, 11.35, 0.45, size=13, color="FFFFFF", bold=True, align=PP_ALIGN.CENTER)
    add_footer(slide, app, 3)

    # 4 — evidence
    slide = prs.slides.add_slide(blank)
    set_background(slide, "FFFFFF")
    add_text(slide, "03 · 현재 확인된 증거", 0.65, 0.45, 7.4, 0.48, size=24, color=app["dark"], bold=True)
    add_text(slide, "현재 사실, 저장된 과거 증거, 목표를 같은 숫자로 섞지 않습니다.", 0.68, 0.98, 9.8, 0.36, size=12, color="667085")
    for idx, (label, value, note) in enumerate(app["evidence"]):
        row, col = divmod(idx, 2)
        x = 0.72 + col * 6.05
        y = 1.68 + row * 2.25
        add_rect(slide, x, y, 5.55, 1.82, fill="F8FAFC", line="E4E7EC")
        add_text(slide, label, x + 0.28, y + 0.22, 2.8, 0.34, size=11, color="667085", bold=True)
        add_text(slide, value, x + 0.28, y + 0.62, 2.7, 0.62, size=25, color=app["accent"], bold=True)
        add_text(slide, note, x + 2.72, y + 0.68, 2.48, 0.58, size=11, color=app["dark"], bold=True, align=PP_ALIGN.RIGHT)
        add_rect(slide, x + 0.28, y + 1.46, 4.99, 0.09, fill="E4E7EC", radius=False)
        add_rect(slide, x + 0.28, y + 1.46, 3.45 + idx * 0.25, 0.09, fill=app["accent"], radius=False)
    add_footer(slide, app, 4)

    # 5 — roadmap
    slide = prs.slides.add_slide(blank)
    set_background(slide, "FFFFFF")
    add_text(slide, "04 · 다음 90일 실행 로드맵", 0.65, 0.45, 8.0, 0.48, size=24, color=app["dark"], bold=True)
    add_text(slide, "HOLD는 실패가 아니라 다음 증거가 들어오기 전까지의 안전한 정지선입니다.", 0.68, 0.98, 10.6, 0.36, size=12, color="667085")
    roadmap_groups = [app["roadmap"][:2], app["roadmap"][2:4], app["roadmap"][4:]]
    headings = ["지금 · P0", "다음 · P0/P1", "그 이후"]
    for idx, group in enumerate(roadmap_groups):
        x = 0.68 + idx * 4.13
        add_rect(slide, x, 1.62, 3.72, 4.55, fill="F8FAFC", line="E4E7EC")
        add_rect(slide, x, 1.62, 3.72, 0.64, fill=app["dark"], radius=False)
        add_text(slide, headings[idx], x + 0.22, 1.75, 3.3, 0.32, size=13, color="FFFFFF", bold=True)
        y = 2.55
        for priority, task, status, owner, due in group:
            add_text(slide, f"{priority} · {status}", x + 0.22, y, 3.2, 0.27, size=9, color=app["accent"], bold=True)
            add_text(slide, task, x + 0.22, y + 0.29, 3.15, 0.58, size=12, color=app["dark"], bold=True)
            add_text(slide, f"{owner} · {due}", x + 0.22, y + 0.88, 3.15, 0.25, size=9, color="667085")
            y += 1.48
    add_footer(slide, app, 5)

    # 6 — decision
    slide = prs.slides.add_slide(blank)
    set_background(slide, "FFFFFF")
    add_text(slide, "05 · 오늘의 결정", 0.65, 0.45, 7.4, 0.48, size=24, color=app["dark"], bold=True)
    add_rect(slide, 0.72, 1.45, 7.52, 3.85, fill=app["light"], line=app["accent"])
    add_text(slide, "DECISION", 1.02, 1.78, 2.0, 0.32, size=11, color=app["accent"], bold=True)
    add_text(slide, app["decision"], 1.02, 2.28, 6.92, 1.45, size=23, color=app["dark"], bold=True)
    add_text(slide, "필요한 다음 증거", 1.02, 4.15, 2.4, 0.32, size=11, color="667085", bold=True)
    add_text(slide, app["ask"], 1.02, 4.5, 6.85, 0.52, size=14, color=app["dark"])
    add_rect(slide, 8.62, 1.45, 3.98, 3.85, fill=app["accent"])
    add_text(slide, "NEXT", 8.95, 1.78, 1.2, 0.32, size=11, color=app["dark"], bold=True)
    add_text(slide, "증거를\n하나의 후보에\n묶는다", 8.95, 2.3, 3.0, 1.7, size=25, color=app["dark"], bold=True)
    add_text(slide, "Source · Artifact · QA", 8.95, 4.48, 3.0, 0.32, size=11, color=app["dark"], bold=True)
    add_text(slide, "감사합니다", 0.72, 6.18, 11.8, 0.48, size=18, color=app["dark"], bold=True, align=PP_ALIGN.CENTER)
    add_footer(slide, app, 6)

    prs.save(path)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("output_root", type=Path)
    parser.add_argument("--refresh-presentations", action="store_true")
    parser.add_argument("--refresh-workbooks", action="store_true")
    args = parser.parse_args()
    root = args.output_root.expanduser().resolve()
    if args.refresh_presentations or args.refresh_workbooks:
        manifest_path = root / "manifest.json"
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        by_slug = {project["slug"]: project for project in manifest["projects"]}
        for app in APPS:
            project = by_slug[app["slug"]]
            project["theme"] = app["theme"]
            if args.refresh_presentations:
                presentation_entry = next(
                    file for file in project["files"] if file["kind"] == "pptx"
                )
                presentation = Path(presentation_entry["path"])
                make_presentation(app, presentation)
                presentation_entry["sha256BeforeCodexOffice"] = sha256(presentation)
                presentation_entry.pop("sha256AfterCodexOffice", None)
            if args.refresh_workbooks:
                workbook_entry = next(
                    file for file in project["files"] if file["kind"] == "xlsx"
                )
                workbook = Path(workbook_entry["path"])
                make_workbook(app, workbook)
                workbook_entry["sha256BeforeCodexOffice"] = sha256(workbook)
                workbook_entry.pop("sha256AfterCodexOffice", None)
        manifest.pop("codexOffice", None)
        manifest_path.write_text(
            json.dumps(manifest, ensure_ascii=False, indent=2) + "\n",
            encoding="utf-8",
        )
        print(json.dumps(manifest, ensure_ascii=False, indent=2))
        return
    root.mkdir(parents=True, exist_ok=False)
    evidence_dir = root / "evidence"
    evidence_dir.mkdir(mode=0o700)
    manifest = {"version": 1, "generatedAt": "2026-08-13T12:00:00Z", "projects": []}
    for app in APPS:
        project_dir = root / app["project"]
        project_dir.mkdir()
        workbook = project_dir / f"{app['title'].split(' · ')[0]}_제품_브리프.xlsx"
        presentation = project_dir / f"{app['title'].split(' · ')[0]}_발표자료.pptx"
        make_workbook(app, workbook)
        make_presentation(app, presentation)
        manifest["projects"].append(
            {
                "slug": app["slug"],
                "name": app["project"],
                "theme": app["theme"],
                "files": [
                    {"kind": "xlsx", "path": str(workbook), "sha256BeforeCodexOffice": sha256(workbook)},
                    {"kind": "pptx", "path": str(presentation), "sha256BeforeCodexOffice": sha256(presentation)},
                ],
            }
        )
    (root / "manifest.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(manifest, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()

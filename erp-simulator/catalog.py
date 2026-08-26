# -*- coding: utf-8 -*-
"""
정비소 목데이터(품목 카탈로그).

왜 하드코딩인가: 이 앱은 MOU 시연/연동 검증용 시뮬레이터라서 실제 정비소 재고
시스템과 연동할 필요가 없다. 대신 실무에서 실제로 나올 법한 품목·가격을 그대로
박아 넣어서, 데모를 볼 때 "장난감 앱"이 아니라 진짜 전산처럼 보이게 하는 게 목적.

각 품목은 productId / name / category / unitPrice 4개 필드만 가진다.
productId 접두사로 카테고리를 구분한다 (P=부품, C=소모품, L=공임) — 화면에는
안 보이지만 나중에 로그/디버깅 때 한눈에 구분하기 좋다.
"""

CATEGORY_PARTS = "부품"
CATEGORY_SUPPLIES = "소모품"
CATEGORY_LABOR = "공임"

# 탭에 보여줄 순서. "전체"는 화면(UI) 쪽에서 합성하는 가상 카테고리라 여기엔 없다.
CATEGORIES = [CATEGORY_PARTS, CATEGORY_SUPPLIES, CATEGORY_LABOR]


def _item(product_id, name, category, unit_price):
    return {
        "productId": product_id,
        "name": name,
        "category": category,
        "unitPrice": unit_price,
    }


CATALOG = [
    # 부품 (P-10xx)
    _item("P-1001", "엔진오일 5W30 (4L)", CATEGORY_PARTS, 45000),
    _item("P-1002", "오일필터", CATEGORY_PARTS, 12000),
    _item("P-1003", "에어클리너", CATEGORY_PARTS, 25000),
    _item("P-1004", "브레이크 패드(프론트)", CATEGORY_PARTS, 88000),
    _item("P-1005", "브레이크 패드(리어)", CATEGORY_PARTS, 76000),
    _item("P-1006", "브레이크 디스크(프론트)", CATEGORY_PARTS, 120000),
    _item("P-1007", "AGM 배터리 70Ah", CATEGORY_PARTS, 210000),
    _item("P-1008", "일반 배터리 60Ah", CATEGORY_PARTS, 130000),
    _item("P-1009", "점화플러그(4개 세트)", CATEGORY_PARTS, 48000),
    _item("P-1010", "금호 크루젠 225/60R17", CATEGORY_PARTS, 138000),
    _item("P-1011", "미쉐린 프라이머시4 205/55R16", CATEGORY_PARTS, 165000),
    _item("P-1012", "구동벨트", CATEGORY_PARTS, 35000),
    _item("P-1013", "라디에이터 호스", CATEGORY_PARTS, 28000),
    # 소모품 (C-20xx)
    _item("C-2001", "에어컨 필터", CATEGORY_SUPPLIES, 18000),
    _item("C-2002", "와이퍼 블레이드(운전석)", CATEGORY_SUPPLIES, 12000),
    _item("C-2003", "와이퍼 블레이드(조수석)", CATEGORY_SUPPLIES, 10000),
    _item("C-2004", "브레이크 오일 DOT4", CATEGORY_SUPPLIES, 15000),
    _item("C-2005", "부동액 (2L)", CATEGORY_SUPPLIES, 22000),
    _item("C-2006", "워셔액", CATEGORY_SUPPLIES, 5000),
    _item("C-2007", "드레인 와셔", CATEGORY_SUPPLIES, 1000),
    _item("C-2008", "미션오일 (1L)", CATEGORY_SUPPLIES, 19000),
    # 공임 (L-30xx)
    _item("L-3001", "엔진오일 교환 공임", CATEGORY_LABOR, 15000),
    _item("L-3002", "타이어 장착 공임", CATEGORY_LABOR, 15000),
    _item("L-3003", "휠 밸런스", CATEGORY_LABOR, 10000),
    _item("L-3004", "타이어 위치교환", CATEGORY_LABOR, 20000),
    _item("L-3005", "브레이크 패드 교체 공임", CATEGORY_LABOR, 40000),
    _item("L-3006", "배터리 교체 공임", CATEGORY_LABOR, 10000),
    _item("L-3007", "정기점검 공임", CATEGORY_LABOR, 30000),
    _item("L-3008", "에어컨 가스 충전 공임", CATEGORY_LABOR, 45000),
    _item("L-3009", "미션오일 교환 공임", CATEGORY_LABOR, 35000),
    _item("L-3010", "하체 점검 공임", CATEGORY_LABOR, 25000),
]


def find_item(product_id):
    """productId로 카탈로그 원본 항목을 찾는다. 장바구니에 담을 때 이름/단가를
    항상 카탈로그 기준으로 다시 붙이기 위해 쓴다(위조 방지 목적은 아니고,
    화면 표시용 데이터 일관성 때문)."""
    for item in CATALOG:
        if item["productId"] == product_id:
            return item
    return None

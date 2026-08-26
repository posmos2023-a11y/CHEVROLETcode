# -*- coding: utf-8 -*-
"""
장바구니 모델.

Qt 위젯(뷰)과 분리해두는 이유: 합계 계산 로직(특히 부가세 역산)은 서버 검증과
반드시 일치해야 하는 부분이라, 위젯 코드에 흩어놓으면 나중에 화면을 고치다가
계산 규칙이 틀어지기 쉽다. 여기 한 군데에 모아두고 자체 점검 스크립트로도
검증한다.
"""


class CartLine:
    """장바구니 한 줄 = 품목 1개 + 수량."""

    def __init__(self, product_id, name, category, unit_price, quantity=1):
        self.product_id = product_id
        self.name = name
        self.category = category
        self.unit_price = unit_price
        self.quantity = quantity

    @property
    def amount(self):
        return self.unit_price * self.quantity

    def to_api_item(self):
        return {
            "productId": self.product_id,
            "name": self.name,
            "category": self.category,
            "unitPrice": self.unit_price,
            "quantity": self.quantity,
        }


class Cart:
    """장바구니 전체. 같은 품목을 두 번 담으면 줄이 늘어나지 않고 수량만 오르게
    하기 위해, 내부적으로 productId -> CartLine 순서를 유지하는 리스트로 관리한다
    (dict만 쓰면 화면에 표시되는 줄 순서가 삽입 순서와 어긋날 수 있어서)."""

    def __init__(self):
        self._lines = []  # list[CartLine], 표에 보여줄 순서 그대로

    def __len__(self):
        return len(self._lines)

    @property
    def lines(self):
        return list(self._lines)

    @property
    def item_count(self):
        """장바구니에 담긴 '종류' 수가 아니라 담긴 물건의 총 개수(수량 합)를
        상단 배지에 보여주기 위한 값."""
        return sum(line.quantity for line in self._lines)

    def is_empty(self):
        return len(self._lines) == 0

    def add(self, catalog_item, quantity=1):
        """이미 담긴 품목이면 수량만 더하고, 처음 담는 품목이면 새 줄을 만든다."""
        for line in self._lines:
            if line.product_id == catalog_item["productId"]:
                line.quantity += quantity
                return line
        line = CartLine(
            product_id=catalog_item["productId"],
            name=catalog_item["name"],
            category=catalog_item["category"],
            unit_price=catalog_item["unitPrice"],
            quantity=quantity,
        )
        self._lines.append(line)
        return line

    def set_quantity(self, product_id, quantity):
        """수량 스피너에서 직접 값을 바꿀 때 쓴다. 0 이하로 내리면 줄 자체를
        지운다 — 스피너를 0으로 내리는 것과 [x] 삭제 버튼을 같은 동작으로
        취급해야 사용자가 헷갈리지 않는다."""
        if quantity <= 0:
            self.remove(product_id)
            return
        for line in self._lines:
            if line.product_id == product_id:
                line.quantity = quantity
                return

    def remove(self, product_id):
        self._lines = [line for line in self._lines if line.product_id != product_id]

    def clear(self):
        self._lines = []

    @property
    def total_amount(self):
        """서버가 그대로 검증하는 값(Σ unitPrice*quantity). round 등 어떤
        보정도 넣으면 안 된다 — 정수 원 단위 곱셈/합만 하므로 부동소수점
        오차가 애초에 생기지 않는다."""
        return sum(line.amount for line in self._lines)

    @property
    def tax_amount(self):
        """부가세 포함가 기준 역산: tax = round(total / 11).
        계약서에 명시된 공식 그대로 — 여기서 다르게 계산하면(예: total*0.1/1.1)
        반올림 지점에서 서버 표시값과 1원 단위로 어긋날 수 있다."""
        return round(self.total_amount / 11)

    @property
    def supply_amount(self):
        return self.total_amount - self.tax_amount

    def build_memo(self, plate_number, customer_name):
        """차량번호/고객명이 하나라도 비어 있으면 memo 자체를 생략(None)한다.
        정비소 직원이 급하게 접수할 때 차량 정보를 안 채우고도 보낼 수 있어야
        하므로 필수값으로 막지 않는다."""
        plate_number = (plate_number or "").strip()
        customer_name = (customer_name or "").strip()
        if not plate_number and not customer_name:
            return None
        parts = []
        if plate_number:
            parts.append(plate_number)
        if customer_name:
            parts.append(f"{customer_name}님")
        return " ".join(parts)

    def to_api_payload(self, store_code, reference_id, memo, auto_pay,
                       business_number=None, car_number=None):
        """연동 요청서 §4.2의 바디를 만든다.

        carNumber와 businessNumber는 memo와 **따로** 보낸다. memo에도 같은 값이 들어가지만
        그건 사람이 POS 화면에서 읽는 용도라 자유 문자열이고, 서버가 기계적으로 쓸 수 없다:
        - businessNumber -> 전산 매장코드를 자동으로 연결하는 데 쓴다
        - carNumber      -> 그날 대기 중인 예약 손님과 잇는 데 쓴다
        빈 값이면 키 자체를 넣지 않는다 — 서버가 "빈 문자열"과 "안 보냄"을 다르게 다룰 이유가
        없고, 불필요한 키를 줄이는 편이 요청을 읽기 쉽다."""
        payload = {
            "storeCode": store_code,
            "referenceId": reference_id,
            "items": [line.to_api_item() for line in self._lines],
            "totalAmount": self.total_amount,
            "memo": memo,
            "autoPay": auto_pay,
        }
        if business_number:
            payload["businessNumber"] = business_number
        if car_number:
            payload["carNumber"] = car_number
        return payload

# -*- coding: utf-8 -*-
"""
쉐보레 정비 전산 (연동 시뮬레이터) - 진입점 + 메인 윈도우.

이 앱의 역할은 "장바구니를 만들어서 POST 한 번 던지는 것"까지다. 그 뒤 토스
POS 플러그인이 장바구니를 받아가서 결제 화면을 띄우는 건 다른 팀이 만드는
중이라 여기서는 상태를 폴링해서 보여주기만 한다(§ 상태 조회).

레이아웃은 좌(품목 선택) : 우(장바구니) = 약 6:4, 상단바 + 하단 상태줄로 구성.
네트워크 호출은 전부 api.py의 QThread 워커를 통해서만 이뤄진다 — 메인 스레드
(이 파일)에서는 절대 requests를 직접 부르지 않는다.
"""

import os
import sys

from PyQt5.QtCore import Qt
from PyQt5.QtGui import QFont
from PyQt5.QtWidgets import (
    QAbstractItemView,
    QAbstractSpinBox,
    QApplication,
    QCheckBox,
    QDialog,
    QFormLayout,
    QFrame,
    QHBoxLayout,
    QHeaderView,
    QLabel,
    QLineEdit,
    QMainWindow,
    QMessageBox,
    QPushButton,
    QSizePolicy,
    QSpinBox,
    QSplitter,
    QTabBar,
    QTableWidget,
    QTableWidgetItem,
    QToolButton,
    QVBoxLayout,
    QWidget,
)

import api
import config as config_module
from cart import Cart
from catalog import CATALOG, CATEGORIES, find_item

BASE_DIR = os.path.dirname(os.path.abspath(__file__))

# 상태줄 색상. 계약서에서 지정한 이모지(✅/❌)는 그대로 쓰되, 색은 토스 톤에
# 맞춰 초록/빨강/노랑 3가지로만 제한한다 — 색이 늘어나면 정비소 직원이 한눈에
# "지금 상황이 좋은지 나쁜지"를 못 읽는다.
STATUS_COLOR_PENDING = "#B58105"
STATUS_COLOR_SUCCESS = "#0F9D58"
STATUS_COLOR_ERROR = "#D93025"
STATUS_COLOR_NEUTRAL = "#5F6B7A"


def format_won(amount):
    return f"{amount:,.0f}원"


class SettingsDialog(QDialog):
    """API 서버 주소 / ERP 토큰 / 매장코드를 편집하는 다이얼로그.

    토큰 입력란은 화면 너머로 훔쳐볼 사람이 있을 수 있는 정비소 카운터
    환경을 고려해 Password 에코 모드로 가린다.
    """

    def __init__(self, cfg, parent=None):
        super().__init__(parent)
        self.setWindowTitle("설정")
        self.setMinimumWidth(440)
        self._cfg = cfg

        self.base_url_edit = QLineEdit(cfg.base_url)
        self.token_edit = QLineEdit(cfg.erp_token)
        self.token_edit.setEchoMode(QLineEdit.Password)
        self.store_code_edit = QLineEdit(cfg.store_code)
        self.business_number_edit = QLineEdit(cfg.business_number)
        self.business_number_edit.setPlaceholderText("123-45-67890 (선택)")

        form = QFormLayout()
        form.setSpacing(12)
        form.addRow("API 서버 주소", self.base_url_edit)
        form.addRow("ERP 토큰", self.token_edit)
        form.addRow("매장코드", self.store_code_edit)
        form.addRow("사업자번호", self.business_number_edit)

        note = QLabel(
            "환경변수(CHEVROLET_API_BASE_URL / CHEVROLET_ERP_TOKEN / "
            "CHEVROLET_STORE_CODE / CHEVROLET_BUSINESS_NUMBER)가 설정되어 있으면 "
            "여기 값보다 우선 적용됩니다. "
            "사업자번호를 채워두면 서버가 이 값으로 매장을 찾아 매장코드를 자동으로 "
            "연결합니다 — 매장코드가 아직 등록되지 않았어도 첫 전송에서 이어집니다."
        )
        note.setWordWrap(True)
        note.setObjectName("HintLabel")

        cancel_btn = QPushButton("취소")
        cancel_btn.clicked.connect(self.reject)
        save_btn = QPushButton("저장")
        save_btn.setObjectName("PrimaryButton")
        save_btn.setDefault(True)
        save_btn.clicked.connect(self._on_save)

        btn_row = QHBoxLayout()
        btn_row.addStretch(1)
        btn_row.addWidget(cancel_btn)
        btn_row.addWidget(save_btn)

        layout = QVBoxLayout(self)
        layout.setContentsMargins(24, 24, 24, 20)
        layout.setSpacing(18)
        layout.addLayout(form)
        layout.addWidget(note)
        layout.addLayout(btn_row)

    def _on_save(self):
        self._cfg.base_url = self.base_url_edit.text().strip() or config_module.DEFAULT_BASE_URL
        self._cfg.erp_token = self.token_edit.text().strip()
        self._cfg.store_code = self.store_code_edit.text().strip() or config_module.DEFAULT_STORE_CODE
        self._cfg.business_number = self.business_number_edit.text().strip()
        config_module.save_config(self._cfg)
        self.accept()


class QuantityWidget(QWidget):
    """장바구니 한 줄의 수량 조작용 위젯(－ / 숫자 / ＋).

    최소값을 1로 둔 이유: 스피너로 0까지 내리는 것과 [×] 삭제 버튼을
    같은 동작으로 취급하면 사용자가 "줄이다 보니 사라졌다"에 당황할 수
    있어서, 삭제는 항상 명시적인 × 버튼으로만 하게 갈랐다.
    """

    def __init__(self, initial_quantity, on_change):
        super().__init__()
        self._on_change = on_change

        self.spin = QSpinBox()
        self.spin.setRange(1, 999)
        self.spin.setValue(initial_quantity)
        self.spin.setButtonSymbols(QAbstractSpinBox.NoButtons)
        self.spin.setAlignment(Qt.AlignCenter)
        self.spin.setFixedWidth(48)

        minus_btn = QToolButton()
        minus_btn.setText("－")
        minus_btn.setObjectName("StepButton")
        minus_btn.clicked.connect(self.spin.stepDown)

        plus_btn = QToolButton()
        plus_btn.setText("＋")
        plus_btn.setObjectName("StepButton")
        plus_btn.clicked.connect(self.spin.stepUp)

        self.spin.valueChanged.connect(self._on_change)

        layout = QHBoxLayout(self)
        layout.setContentsMargins(4, 2, 4, 2)
        layout.setSpacing(4)
        layout.addWidget(minus_btn)
        layout.addWidget(self.spin)
        layout.addWidget(plus_btn)
        layout.addStretch(1)


class MainWindow(QMainWindow):
    def __init__(self):
        super().__init__()
        self.cfg = config_module.load_config()
        self.cart = Cart()

        self._active_category = "전체"
        self._search_text = ""

        self._current_reference_id = None
        self._threads = []  # (QThread, QObject) 진행 중인 워커들. 창 종료 시 정리한다.
        # 전송 직전의 장바구니 보관본. POS 담기 실패/응답없음일 때 [장바구니 복원]으로 되살린다.
        self._restorable = None
        self._poll_thread = None
        self._poll_worker = None

        self.setWindowTitle("쉐보레 정비 전산 (연동 시뮬레이터)")
        self.setMinimumSize(1100, 720)
        self.resize(1180, 780)

        self._build_ui()
        self._reload_items_table()
        self._refresh_cart_ui()
        self._update_store_code_label()

    # ------------------------------------------------------------------
    # UI 구성
    # ------------------------------------------------------------------
    def _build_ui(self):
        central = QWidget()
        self.setCentralWidget(central)
        root = QVBoxLayout(central)
        root.setContentsMargins(0, 0, 0, 0)
        root.setSpacing(0)

        root.addWidget(self._build_top_bar())

        splitter = QSplitter(Qt.Horizontal)
        splitter.setChildrenCollapsible(False)
        splitter.setHandleWidth(1)
        splitter.addWidget(self._build_left_panel())
        splitter.addWidget(self._build_right_panel())
        splitter.setStretchFactor(0, 3)
        splitter.setStretchFactor(1, 2)
        splitter.setSizes([700, 460])
        root.addWidget(splitter, 1)

        self._build_status_bar()

    def _build_top_bar(self):
        bar = QFrame()
        bar.setObjectName("TopBar")
        bar.setFixedHeight(60)

        title = QLabel("쉐보레 정비 전산 (연동 시뮬레이터)")
        title.setObjectName("AppTitle")

        self.store_code_label = QLabel()
        self.store_code_label.setObjectName("StoreCodeBadge")

        settings_btn = QPushButton("설정")
        settings_btn.setObjectName("SettingsButton")
        settings_btn.clicked.connect(self.open_settings)

        layout = QHBoxLayout(bar)
        layout.setContentsMargins(24, 0, 20, 0)
        layout.setSpacing(14)
        layout.addWidget(title)
        layout.addWidget(self.store_code_label)
        layout.addStretch(1)
        layout.addWidget(settings_btn)
        return bar

    def _build_left_panel(self):
        panel = QWidget()
        layout = QVBoxLayout(panel)
        layout.setContentsMargins(20, 18, 12, 18)
        layout.setSpacing(12)

        # 차량 정보 입력란 (한 줄)
        vehicle_row = QHBoxLayout()
        vehicle_row.setSpacing(10)
        plate_label = QLabel("차량번호")
        plate_label.setObjectName("FieldLabel")
        self.plate_edit = QLineEdit()
        self.plate_edit.setPlaceholderText("예: 12가3456")
        customer_label = QLabel("고객명")
        customer_label.setObjectName("FieldLabel")
        self.customer_edit = QLineEdit()
        self.customer_edit.setPlaceholderText("예: 김민준")
        vehicle_row.addWidget(plate_label)
        vehicle_row.addWidget(self.plate_edit, 2)
        vehicle_row.addWidget(customer_label)
        vehicle_row.addWidget(self.customer_edit, 2)
        layout.addLayout(vehicle_row)

        # 카테고리 탭
        self.category_tabs = QTabBar()
        self.category_tabs.setObjectName("CategoryTabs")
        self.category_tabs.addTab("전체")
        for category in CATEGORIES:
            self.category_tabs.addTab(category)
        self.category_tabs.currentChanged.connect(self._on_category_changed)
        layout.addWidget(self.category_tabs)

        # 검색창
        self.search_edit = QLineEdit()
        self.search_edit.setObjectName("SearchInput")
        self.search_edit.setPlaceholderText("품목명 검색")
        self.search_edit.textChanged.connect(self._on_search_changed)
        layout.addWidget(self.search_edit)

        # 품목 테이블
        self.items_table = QTableWidget(0, 4)
        self.items_table.setObjectName("ItemsTable")
        self.items_table.setHorizontalHeaderLabels(["품목명", "카테고리", "단가", ""])
        self.items_table.verticalHeader().setVisible(False)
        self.items_table.verticalHeader().setDefaultSectionSize(38)
        self.items_table.setEditTriggers(QAbstractItemView.NoEditTriggers)
        self.items_table.setSelectionBehavior(QAbstractItemView.SelectRows)
        self.items_table.setSelectionMode(QAbstractItemView.SingleSelection)
        self.items_table.setShowGrid(False)
        self.items_table.cellDoubleClicked.connect(self._on_item_row_double_clicked)

        header = self.items_table.horizontalHeader()
        header.setSectionResizeMode(0, QHeaderView.Stretch)
        header.setSectionResizeMode(1, QHeaderView.Fixed)
        header.setSectionResizeMode(2, QHeaderView.Fixed)
        header.setSectionResizeMode(3, QHeaderView.Fixed)
        self.items_table.setColumnWidth(1, 76)
        self.items_table.setColumnWidth(2, 110)
        self.items_table.setColumnWidth(3, 92)

        layout.addWidget(self.items_table, 1)
        return panel

    def _build_right_panel(self):
        panel = QWidget()
        panel.setObjectName("CartPanel")
        layout = QVBoxLayout(panel)
        layout.setContentsMargins(12, 18, 20, 18)
        layout.setSpacing(12)

        self.cart_title_label = QLabel("장바구니")
        self.cart_title_label.setObjectName("SectionTitle")
        layout.addWidget(self.cart_title_label)

        self.cart_table = QTableWidget(0, 4)
        self.cart_table.setObjectName("CartTable")
        self.cart_table.setHorizontalHeaderLabels(["품목명", "수량", "금액", ""])
        self.cart_table.verticalHeader().setVisible(False)
        self.cart_table.verticalHeader().setDefaultSectionSize(40)
        self.cart_table.setEditTriggers(QAbstractItemView.NoEditTriggers)
        self.cart_table.setSelectionMode(QAbstractItemView.NoSelection)
        self.cart_table.setShowGrid(False)

        header = self.cart_table.horizontalHeader()
        header.setSectionResizeMode(0, QHeaderView.Stretch)
        header.setSectionResizeMode(1, QHeaderView.Fixed)
        header.setSectionResizeMode(2, QHeaderView.Fixed)
        header.setSectionResizeMode(3, QHeaderView.Fixed)
        self.cart_table.setColumnWidth(1, 130)
        self.cart_table.setColumnWidth(2, 100)
        self.cart_table.setColumnWidth(3, 44)

        layout.addWidget(self.cart_table, 1)

        # 합계 영역
        totals_frame = QFrame()
        totals_frame.setObjectName("TotalsFrame")
        totals_layout = QVBoxLayout(totals_frame)
        totals_layout.setContentsMargins(16, 14, 16, 14)
        totals_layout.setSpacing(6)

        self.supply_value_label = QLabel(format_won(0))
        self.tax_value_label = QLabel(format_won(0))
        self.total_value_label = QLabel(format_won(0))
        self.total_value_label.setObjectName("TotalValue")

        totals_layout.addLayout(self._totals_row("공급가", self.supply_value_label))
        totals_layout.addLayout(self._totals_row("부가세", self.tax_value_label))
        divider = QFrame()
        divider.setObjectName("TotalsDivider")
        divider.setFixedHeight(1)
        totals_layout.addWidget(divider)
        total_row = self._totals_row("합계", self.total_value_label, big=True)
        totals_layout.addLayout(total_row)

        layout.addWidget(totals_frame)

        self.auto_pay_checkbox = QCheckBox("결제까지 자동 진행")
        self.auto_pay_checkbox.setChecked(True)
        layout.addWidget(self.auto_pay_checkbox)

        btn_row = QHBoxLayout()
        btn_row.setSpacing(10)
        self.clear_button = QPushButton("비우기")
        self.clear_button.setObjectName("SecondaryButton")
        self.clear_button.clicked.connect(self._on_clear_cart_clicked)
        self.send_button = QPushButton("POS로 전송")
        self.send_button.setObjectName("PrimaryButton")
        self.send_button.clicked.connect(self._on_send_clicked)
        btn_row.addWidget(self.clear_button, 1)
        btn_row.addWidget(self.send_button, 2)
        layout.addLayout(btn_row)

        return panel

    def _totals_row(self, label_text, value_label, big=False):
        row = QHBoxLayout()
        label = QLabel(label_text)
        label.setObjectName("TotalBigLabel" if big else "TotalLabel")
        value_label.setAlignment(Qt.AlignRight | Qt.AlignVCenter)
        row.addWidget(label)
        row.addStretch(1)
        row.addWidget(value_label)
        return row

    def _build_status_bar(self):
        status_bar = self.statusBar()
        status_bar.setSizeGripEnabled(False)

        self.status_label = QLabel("대기 중")
        self.status_label.setObjectName("StatusLabel")
        status_bar.addWidget(self.status_label, 1)

        # 전송에 성공하면 다음 손님을 받으려고 장바구니를 즉시 비운다. 그런데 POS 쪽에서
        # 담기가 실패하면 그 건은 서버에서 끝난 상태(failed)라 전산이 다시 보내야 하는데,
        # 장바구니가 이미 비어 있어서 직원이 품목을 처음부터 다시 골라야 한다 — 부품 여러 개에
        # 공임까지 섞인 정비 주문에서는 이게 꽤 큰 손해다. 그래서 보낸 내용을 그대로 들고 있다가
        # 실패/응답없음일 때만 이 버튼으로 되살린다.
        self.status_restore_button = QPushButton("장바구니 복원")
        self.status_restore_button.setObjectName("StatusRestoreButton")
        self.status_restore_button.setVisible(False)
        self.status_restore_button.clicked.connect(self._on_restore_clicked)
        status_bar.addPermanentWidget(self.status_restore_button)

        self.status_cancel_button = QPushButton("취소")
        self.status_cancel_button.setObjectName("StatusCancelButton")
        self.status_cancel_button.setVisible(False)
        self.status_cancel_button.clicked.connect(self._on_cancel_clicked)
        status_bar.addPermanentWidget(self.status_cancel_button)

    def _update_store_code_label(self):
        self.store_code_label.setText(self.cfg.store_code or "-")

    # ------------------------------------------------------------------
    # 품목 목록 (좌측)
    # ------------------------------------------------------------------
    def _on_category_changed(self, index):
        self._active_category = self.category_tabs.tabText(index)
        self._reload_items_table()

    def _on_search_changed(self, text):
        self._search_text = text.strip()
        self._reload_items_table()

    def _filtered_items(self):
        keyword = self._search_text.lower()
        result = []
        for item in CATALOG:
            if self._active_category != "전체" and item["category"] != self._active_category:
                continue
            if keyword and keyword not in item["name"].lower():
                continue
            result.append(item)
        return result

    def _reload_items_table(self):
        items = self._filtered_items()
        self.items_table.setRowCount(len(items))
        for row, item in enumerate(items):
            name_cell = QTableWidgetItem(item["name"])
            name_cell.setData(Qt.UserRole, item["productId"])
            category_cell = QTableWidgetItem(item["category"])
            category_cell.setTextAlignment(Qt.AlignCenter)
            price_cell = QTableWidgetItem(format_won(item["unitPrice"]))
            price_cell.setTextAlignment(Qt.AlignRight | Qt.AlignVCenter)

            self.items_table.setItem(row, 0, name_cell)
            self.items_table.setItem(row, 1, category_cell)
            self.items_table.setItem(row, 2, price_cell)

            add_btn = QPushButton("담기")
            add_btn.setObjectName("AddButton")
            add_btn.clicked.connect(lambda _checked=False, pid=item["productId"]: self._add_to_cart(pid))
            self.items_table.setCellWidget(row, 3, add_btn)

    def _on_item_row_double_clicked(self, row, _column):
        name_item = self.items_table.item(row, 0)
        if name_item is None:
            return
        product_id = name_item.data(Qt.UserRole)
        self._add_to_cart(product_id)

    def _add_to_cart(self, product_id):
        item = next((c for c in CATALOG if c["productId"] == product_id), None)
        if item is None:
            return
        self.cart.add(item, 1)
        self._refresh_cart_ui()

    # ------------------------------------------------------------------
    # 장바구니 (우측)
    # ------------------------------------------------------------------
    def _refresh_cart_ui(self):
        self.cart_title_label.setText(f"장바구니 ({self.cart.item_count})")

        lines = self.cart.lines
        self.cart_table.setRowCount(len(lines))
        for row, line in enumerate(lines):
            name_cell = QTableWidgetItem(line.name)
            self.cart_table.setItem(row, 0, name_cell)

            qty_widget = QuantityWidget(
                line.quantity,
                on_change=lambda value, pid=line.product_id: self._on_quantity_changed(pid, value),
            )
            self.cart_table.setCellWidget(row, 1, qty_widget)

            amount_cell = QTableWidgetItem(format_won(line.amount))
            amount_cell.setTextAlignment(Qt.AlignRight | Qt.AlignVCenter)
            self.cart_table.setItem(row, 2, amount_cell)

            remove_btn = QPushButton("×")
            remove_btn.setObjectName("RemoveButton")
            remove_btn.clicked.connect(lambda _checked=False, pid=line.product_id: self._on_remove_line(pid))
            self.cart_table.setCellWidget(row, 3, remove_btn)

        self.supply_value_label.setText(format_won(self.cart.supply_amount))
        self.tax_value_label.setText(format_won(self.cart.tax_amount))
        self.total_value_label.setText(format_won(self.cart.total_amount))

        self._update_send_button_enabled()

    def _on_quantity_changed(self, product_id, value):
        self.cart.set_quantity(product_id, value)
        # 개별 셀만 갱신하면 되지만, 행 순서가 바뀌지 않는 수량 변경은 전체
        # 테이블을 다시 그려도 QuantityWidget이 재생성되며 스핀박스 포커스가
        # 튀는 부작용이 있다. 대신 금액 셀과 합계만 부분적으로 갱신한다.
        for row, line in enumerate(self.cart.lines):
            if line.product_id == product_id:
                self.cart_table.item(row, 2).setText(format_won(line.amount))
                break
        self.supply_value_label.setText(format_won(self.cart.supply_amount))
        self.tax_value_label.setText(format_won(self.cart.tax_amount))
        self.total_value_label.setText(format_won(self.cart.total_amount))
        self.cart_title_label.setText(f"장바구니 ({self.cart.item_count})")

    def _on_remove_line(self, product_id):
        self.cart.remove(product_id)
        self._refresh_cart_ui()

    def _on_clear_cart_clicked(self):
        self.cart.clear()
        self._refresh_cart_ui()

    def _update_send_button_enabled(self):
        sending = getattr(self, "_is_sending", False)
        self.send_button.setEnabled((not self.cart.is_empty()) and not sending)

    # ------------------------------------------------------------------
    # 설정
    # ------------------------------------------------------------------
    def open_settings(self):
        dialog = SettingsDialog(self.cfg, self)
        if dialog.exec_() == QDialog.Accepted:
            # 저장 직후 다시 load_config()를 부르는 이유: 환경변수가 걸려있으면
            # 방금 다이얼로그에 입력한 값보다 환경변수가 우선해야 하므로,
            # 파일 저장 결과를 그대로 믿지 않고 우선순위 규칙을 다시 적용한다.
            self.cfg = config_module.load_config()
            self._update_store_code_label()

    # ------------------------------------------------------------------
    # POS 전송
    # ------------------------------------------------------------------
    def _on_send_clicked(self):
        if self.cart.is_empty():
            return

        if not self.cfg.erp_token:
            QMessageBox.warning(self, "ERP 토큰 필요", "설정에서 ERP 토큰을 먼저 입력해주세요.")
            self.open_settings()
            return

        reference_id = api.make_reference_id()
        memo = self.cart.build_memo(self.plate_edit.text(), self.customer_edit.text())
        payload = self.cart.to_api_payload(
            store_code=self.cfg.store_code,
            reference_id=reference_id,
            memo=memo,
            auto_pay=self.auto_pay_checkbox.isChecked(),
            # memo에도 같은 값이 들어가지만 그건 사람이 POS 화면에서 읽는 용도다. 서버가
            # 기계적으로 쓰려면 별도 필드여야 한다(연동 요청서 §4.3).
            business_number=self.cfg.business_number,
            car_number=self.plate_edit.text().strip(),
        )

        # 새로 보내는 순간 직전 건의 복원 제안은 의미가 없다(보관본은 아래에서 새로 덮인다).
        self.status_restore_button.setVisible(False)
        self._is_sending = True
        self._update_send_button_enabled()
        self.send_button.setText("전송 중...")
        self._set_status(f"전송 중... ({reference_id})", STATUS_COLOR_PENDING)
        self.status_cancel_button.setVisible(False)

        client = api.ApiClient(self.cfg.base_url, self.cfg.erp_token)
        worker = api.SendCartWorker(client, payload)
        thread = api.run_in_thread(worker)
        worker.succeeded.connect(lambda result: self._on_send_succeeded(reference_id, result))
        worker.failed.connect(self._on_send_failed)
        worker.succeeded.connect(thread.quit)
        worker.failed.connect(thread.quit)
        worker.succeeded.connect(worker.deleteLater)
        worker.failed.connect(worker.deleteLater)
        self._register_thread(thread, worker)
        thread.start()

    def _on_send_succeeded(self, reference_id, result):
        self._is_sending = False
        self.send_button.setText("POS로 전송")

        if not result.get("ok", True):
            self._on_send_failed(result.get("error") or "알 수 없는 오류가 발생했습니다.")
            return

        # duplicate는 "이 referenceId는 이미 접수돼 있다"는 뜻이다. 이 앱은 전송할 때마다
        # referenceId를 새로 만들고 자동 재시도도 하지 않으므로, 첫 전송에 duplicate가 왔다면
        # 주문번호가 다른 건과 겹쳤다는 뜻이다. 그 경우 **이번 장바구니는 어디에도 만들어지지
        # 않는다.** 성공으로 삼키고 장바구니를 비우면 직원은 보냈다고 믿는데 POS엔 안 뜬다 —
        # 돈이 걸린 경로라 조용히 넘기지 않고, 장바구니를 그대로 둔 채 다시 누르게 한다.
        if result.get("duplicate"):
            self._update_send_button_enabled()
            self._set_status(
                "❌ 주문번호가 중복됐습니다. 전송되지 않았으니 [POS로 전송]을 한 번 더 눌러주세요.",
                STATUS_COLOR_ERROR,
            )
            return

        # 비우기 직전에 보낸 내용을 그대로 보관한다. POS가 담기에 실패하면 그 건은 서버에서
        # 끝난 상태라 전산이 다시 보내야 하는데, 그때 직원이 품목을 처음부터 다시 고르지
        # 않도록 [장바구니 복원]으로 되돌려주기 위해서다.
        self._restorable = {
            "lines": [(line.product_id, line.quantity) for line in self.cart.lines],
            "plate": self.plate_edit.text(),
            "customer": self.customer_edit.text(),
            # POS가 담기 실패를 명확히 알려준 경우(False)와, 60초 동안 응답이 없어
            # 아직 담길 수도 있는 경우(True)를 구분한다 — 후자는 복원 시 확인을 받는다.
            "uncertain": False,
        }

        # 전송 자체가 성공했으니(멱등 중복 포함) 다음 손님을 받을 수 있게
        # 장바구니와 차량 정보를 바로 비운다 — POS가 실제로 담았는지는
        # 이어지는 폴링이 별도로 알려준다.
        self.cart.clear()
        self.plate_edit.clear()
        self.customer_edit.clear()
        self._refresh_cart_ui()

        self._current_reference_id = reference_id
        self._set_status(f"전송됨 · POS 대기 중... ({reference_id})", STATUS_COLOR_PENDING)
        self._start_poll(reference_id)

    def _on_send_failed(self, message):
        self._is_sending = False
        self.send_button.setText("POS로 전송")
        self._update_send_button_enabled()
        self._set_status(f"❌ 전송 실패: {message}", STATUS_COLOR_ERROR)

    # ------------------------------------------------------------------
    # 상태 폴링
    # ------------------------------------------------------------------
    def _start_poll(self, reference_id):
        client = api.ApiClient(self.cfg.base_url, self.cfg.erp_token)
        worker = api.PollStatusWorker(client, reference_id)
        thread = api.run_in_thread(worker)

        worker.status_changed.connect(lambda result: self._on_poll_status_changed(reference_id, result))
        worker.timed_out.connect(lambda: self._on_poll_timed_out(reference_id))
        worker.poll_failed.connect(lambda msg: self._on_poll_failed(reference_id, msg))
        for signal in (worker.status_changed, worker.timed_out, worker.poll_failed):
            signal.connect(thread.quit)
        worker.status_changed.connect(worker.deleteLater)
        worker.timed_out.connect(worker.deleteLater)
        worker.poll_failed.connect(worker.deleteLater)

        self._poll_thread = thread
        self._poll_worker = worker
        self._register_thread(thread, worker)
        thread.start()

        self.status_cancel_button.setVisible(True)

    def _is_current_reference(self, reference_id):
        return reference_id == self._current_reference_id

    def _on_poll_status_changed(self, reference_id, result):
        if not self._is_current_reference(reference_id):
            return  # 이미 취소되었거나 새 전송으로 대체된 낡은 결과는 무시한다.

        status = result.get("status")
        if status == "loaded":
            amount = result.get("totalAmount") or 0
            self._set_status(f"✅ POS 장바구니에 담겼습니다 · {format_won(amount)}", STATUS_COLOR_SUCCESS)
            # 정상적으로 담겼으면 되살릴 이유가 없다 — 복원 버튼을 눌러 같은 주문을 두 번
            # 보내는 사고를 막기 위해 보관본을 지운다.
            self._restorable = None
        elif status == "failed":
            reason = result.get("errorMessage") or "이유가 전달되지 않았습니다."
            self._set_status(f"❌ POS에서 담기 실패: {reason}", STATUS_COLOR_ERROR)
            self._offer_restore()
        elif status == "cancelled":
            self._set_status(f"취소되었습니다 ({reference_id})", STATUS_COLOR_NEUTRAL)
        else:
            self._set_status(f"상태: {status} ({reference_id})", STATUS_COLOR_NEUTRAL)

        self._current_reference_id = None
        self.status_cancel_button.setVisible(False)
        self._poll_thread = None
        self._poll_worker = None

    def _on_poll_timed_out(self, reference_id):
        if not self._is_current_reference(reference_id):
            return
        self._set_status(
            f"⏱ 응답 없음 · 60초 동안 POS가 가져가지 않았습니다 ({reference_id})", STATUS_COLOR_PENDING
        )
        # 타임아웃은 "아직 pending"일 뿐 실패가 아니다 — POS가 나중에 담아갈 수도 있다.
        # 그래서 복원은 제공하되, 되살려 다시 보내면 중복이 될 수 있다는 걸 버튼을 눌렀을 때
        # 확인받는다(_on_restore_clicked).
        if self._restorable:
            self._restorable["uncertain"] = True
        self._offer_restore()
        self._current_reference_id = None
        self.status_cancel_button.setVisible(False)
        self._poll_thread = None
        self._poll_worker = None

    def _on_poll_failed(self, reference_id, message):
        if not self._is_current_reference(reference_id):
            return
        self._set_status(f"❌ 상태 확인 실패: {message}", STATUS_COLOR_ERROR)
        self._current_reference_id = None
        self.status_cancel_button.setVisible(False)
        self._poll_thread = None
        self._poll_worker = None

    def _on_cancel_clicked(self):
        reference_id = self._current_reference_id
        if not reference_id:
            return

        client = api.ApiClient(self.cfg.base_url, self.cfg.erp_token)
        worker = api.CancelCartWorker(client, reference_id)
        thread = api.run_in_thread(worker)
        worker.succeeded.connect(lambda result: self._on_cancel_succeeded(reference_id, result))
        worker.failed.connect(self._on_cancel_failed)
        worker.succeeded.connect(thread.quit)
        worker.failed.connect(thread.quit)
        worker.succeeded.connect(worker.deleteLater)
        worker.failed.connect(worker.deleteLater)
        self._register_thread(thread, worker)
        thread.start()

        self.status_cancel_button.setEnabled(False)

    def _on_cancel_succeeded(self, reference_id, _result):
        self.status_cancel_button.setEnabled(True)
        if not self._is_current_reference(reference_id):
            return
        # 폴링 워커가 아직 돌고 있다면 stop 플래그를 세워 다음 턴에 조용히
        # 빠져나가게 한다. 이미 status_changed/timed_out으로 끝났다면
        # _poll_worker는 None이라 이 줄은 아무것도 하지 않는다.
        if self._poll_worker is not None:
            self._poll_worker.stop()
        self._set_status(f"취소되었습니다 ({reference_id})", STATUS_COLOR_NEUTRAL)
        self._current_reference_id = None
        self.status_cancel_button.setVisible(False)
        self._poll_thread = None
        self._poll_worker = None

    def _on_cancel_failed(self, message):
        self.status_cancel_button.setEnabled(True)
        QMessageBox.warning(self, "취소 불가", message)

    # ------------------------------------------------------------------
    # 상태줄 / 스레드 관리
    # ------------------------------------------------------------------
    def _set_status(self, text, color):
        self.status_label.setText(text)
        self.status_label.setStyleSheet(f"color: {color}; font-weight: 600;")

    # ------------------------------------------------------------------
    # 장바구니 복원 (POS 담기 실패 / 응답 없음일 때)
    # ------------------------------------------------------------------
    def _offer_restore(self):
        """되살릴 내용이 있고 지금 장바구니가 비어 있을 때만 버튼을 띄운다.
        직원이 이미 다음 손님 것을 담기 시작했는데 복원 버튼이 보이면, 눌렀을 때 두 손님의
        품목이 섞여버린다 — 그 사고를 애초에 만들지 않는다."""
        if self._restorable and self.cart.is_empty():
            self.status_restore_button.setVisible(True)

    def _on_restore_clicked(self):
        snapshot = self._restorable
        if not snapshot:
            self.status_restore_button.setVisible(False)
            return

        if not self.cart.is_empty():
            # _offer_restore가 막고 있지만, 버튼이 떠 있는 사이에 품목을 담았을 수 있다.
            QMessageBox.warning(
                self, "복원할 수 없습니다",
                "장바구니에 이미 담긴 품목이 있습니다. 비운 뒤에 다시 눌러주세요.",
            )
            return

        # 아직 서버에서 pending일 수 있는 건(응답 없음)을 되살려 다시 보내면 같은 주문이 두 번
        # 담길 수 있다. 되돌릴 수 없는 결과라 사람에게 한 번 확인받는다.
        if snapshot.get("uncertain"):
            answer = QMessageBox.question(
                self, "장바구니 복원",
                "직전 주문이 아직 POS에 담기지 않았을 뿐일 수 있습니다.\n"
                "복원해서 다시 보내면 같은 주문이 두 번 담길 수 있습니다.\n\n계속할까요?",
                QMessageBox.Yes | QMessageBox.No, QMessageBox.No,
            )
            if answer != QMessageBox.Yes:
                return

        restored = 0
        for product_id, quantity in snapshot["lines"]:
            item = find_item(product_id)
            if item is None:
                continue  # 목데이터가 바뀐 경우 — 없는 품목은 조용히 건너뛴다.
            self.cart.add(item, quantity)
            restored += 1
        self.plate_edit.setText(snapshot.get("plate", ""))
        self.customer_edit.setText(snapshot.get("customer", ""))
        self._refresh_cart_ui()

        self._restorable = None
        self.status_restore_button.setVisible(False)
        self._set_status(f"장바구니를 복원했습니다 · {restored}개 품목", STATUS_COLOR_NEUTRAL)

    def _register_thread(self, thread, worker):
        entry = (thread, worker)
        self._threads.append(entry)

        def _cleanup():
            if entry in self._threads:
                self._threads.remove(entry)
            thread.deleteLater()

        thread.finished.connect(_cleanup)

    def closeEvent(self, event):
        # 창을 닫을 때 폴링 워커가 계속 서버를 두드리며 살아남지 않도록,
        # stop 플래그를 세우고 각 스레드가 정리될 때까지 기다린다.
        for thread, worker in list(self._threads):
            if hasattr(worker, "stop"):
                worker.stop()
        for thread, _worker in list(self._threads):
            thread.quit()
            thread.wait(3000)
        super().closeEvent(event)


def main():
    app = QApplication(sys.argv)

    # "맑은 고딕"이 없는 플랫폼(리눅스/맥)에서는 Qt가 자동으로 시스템 기본
    # 폰트로 대체하므로 별도 존재 확인 로직 없이 그냥 지정만 한다.
    app.setFont(QFont("맑은 고딕", 10))

    # style.qss는 읽기 전용 리소스라 번들 안(sys._MEIPASS)에서 찾아야 한다 — BASE_DIR로 두면
    # exe로 묶었을 때 스타일이 통째로 안 먹는다(config.py의 resource_dir 주석 참고).
    qss_path = os.path.join(config_module.resource_dir(), "style.qss")
    if os.path.exists(qss_path):
        with open(qss_path, "r", encoding="utf-8") as f:
            app.setStyleSheet(f.read())

    window = MainWindow()
    window.show()
    sys.exit(app.exec_())


if __name__ == "__main__":
    main()

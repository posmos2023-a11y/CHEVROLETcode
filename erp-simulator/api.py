# -*- coding: utf-8 -*-
"""
백엔드 HTTP 클라이언트 + Qt 워커 스레드.

왜 스레드가 필요한가: PyQt5는 GUI 이벤트 루프가 메인 스레드 하나뿐이라,
requests.post를 메인 스레드에서 그대로 부르면 응답이 올 때까지(최악의 경우
타임아웃 10초 내내) 창 전체가 멈춘다. POS 서버가 지금 개발 중이라 응답이
늦거나 아예 안 올 수도 있으니, 반드시 QThread 위에서 돌리고 결과는 시그널로만
메인 스레드에 전달한다.

여기 있는 두 워커(SendCartWorker, PollStatusWorker)는 QObject를 만들어
QThread.moveToThread로 옮기는 표준 패턴을 쓴다. QRunnable 대신 이 방식을 쓴
이유는 폴링 워커처럼 "실행 중 취소 가능한" 장시간 루프에는 자체 QThread를 쥐고
있는 편이 정지 신호(stop) 처리가 더 명확하기 때문.
"""

import secrets
import time
from datetime import datetime

import requests
from PyQt5.QtCore import QObject, QThread, pyqtSignal


class ApiError(Exception):
    """네트워크 예외/HTTP 에러를 한국어 메시지 하나로 통일해서 화면에 그대로
    보여주기 위한 래퍼. 스택트레이스를 사용자에게 보여주면 안 되므로,
    호출부에서는 이 예외의 문자열만 쓰면 된다."""


def make_reference_id():
    """ERP-YYYYMMDD-HHMMSS-<6자리 hex> 형식.

    앞부분을 시각으로 두는 건 사람이 상태줄에서 눈으로 읽고 알아보기 위해서다.
    뒤에 난수를 붙이는 건 같은 초에 두 번 보내도 겹치지 않게 하기 위한 것인데,
    처음엔 3자리 숫자(1/1000)를 썼다. 그 정도로는 부족하다 — 겹치면 서버가
    멱등 처리로 duplicate를 돌려주고, 두 번째 주문은 **아무 데도 만들어지지
    않은 채 사라진다.** 직원은 보냈다고 믿는데 POS에는 안 뜬다.
    돈이 걸린 경로라 조용한 실패를 남기지 않도록 1/16,777,216으로 낮춘다.
    (random 대신 secrets를 쓰는 건 예측 가능한 시드로 값이 겹치는 걸 막기 위함.)"""
    now = datetime.now()
    return now.strftime("ERP-%Y%m%d-%H%M%S-") + secrets.token_hex(3).upper()


class ApiClient:
    """requests 세션을 얇게 감싼 것. 워커가 아니라 이 클래스 자체는 스레드
    안전성을 신경 쓰지 않는다 — 항상 워커 스레드 안에서만 호출되는 걸
    전제로 한다(메인 스레드에서 절대 호출하지 말 것)."""

    TIMEOUT_SECONDS = 10

    def __init__(self, base_url, erp_token):
        self.base_url = (base_url or "").rstrip("/")
        self.erp_token = erp_token or ""

    def _headers(self):
        return {
            "X-ERP-Token": self.erp_token,
            "Content-Type": "application/json",
        }

    def _request(self, method, path, json_body=None):
        url = f"{self.base_url}{path}"
        try:
            resp = requests.request(
                method, url, headers=self._headers(), json=json_body, timeout=self.TIMEOUT_SECONDS
            )
        except requests.RequestException as exc:
            # 서버가 아직 배포 전이거나 네트워크가 끊긴 경우가 실제로 자주
            # 있을 거라(계약서에도 명시됨) 예외 종류별로 메시지를 다르게
            # 만들지 않고 하나로 뭉뚱그린다 — 사용자가 알아야 할 건
            # "지금은 연결이 안 된다"는 사실뿐이다.
            raise ApiError(f"서버에 연결할 수 없습니다: {exc}") from exc

        try:
            data = resp.json()
        except ValueError:
            data = None

        if resp.status_code >= 400:
            error_message = None
            if isinstance(data, dict):
                error_message = data.get("error")
            error_message = error_message or f"서버 오류 (HTTP {resp.status_code})"
            raise ApiError(error_message)

        if data is None:
            raise ApiError("서버 응답을 해석할 수 없습니다.")

        return data

    def send_cart(self, payload):
        return self._request("POST", "/api/erp/carts", json_body=payload)

    def get_status(self, reference_id):
        return self._request("GET", f"/api/erp/carts/{reference_id}")

    def cancel_cart(self, reference_id):
        return self._request("POST", f"/api/erp/carts/{reference_id}/cancel")


class SendCartWorker(QObject):
    """장바구니 전송 1회를 스레드에서 실행한다. 성공/실패 둘 다 finished
    한 번만 나가게 해서, 호출부가 "이번 전송이 끝났다"는 신호를 하나로만
    받게 한다(중복 처리 방지)."""

    succeeded = pyqtSignal(dict)
    failed = pyqtSignal(str)

    def __init__(self, client, payload):
        super().__init__()
        self._client = client
        self._payload = payload

    def run(self):
        try:
            result = self._client.send_cart(self._payload)
            self.succeeded.emit(result)
        except ApiError as exc:
            self.failed.emit(str(exc))


class CancelCartWorker(QObject):
    """취소 버튼 1회 클릭 = 요청 1회. SendCartWorker와 구조가 거의 같지만
    응답 바디가 다르고(status만 옴) 실패 시 409(이미 담긴 뒤)를 사람이
    읽을 메시지로 그대로 올려보내야 해서 별도 클래스로 둔다."""

    succeeded = pyqtSignal(dict)
    failed = pyqtSignal(str)

    def __init__(self, client, reference_id):
        super().__init__()
        self._client = client
        self._reference_id = reference_id

    def run(self):
        try:
            result = self._client.cancel_cart(self._reference_id)
            self.succeeded.emit(result)
        except ApiError as exc:
            self.failed.emit(str(exc))


class PollStatusWorker(QObject):
    """전송 성공 후 2초 간격으로 최대 60초까지 상태를 조회한다.
    status가 pending이 아니게 되면(loaded/failed/cancelled) 즉시 멈추고
    결과를 알린다. 60초 동안 계속 pending이면 timed_out을 보내
    "POS가 아직 안 받아갔다"는 걸 알린다 — 무한정 돌리면 사용자가 앱을
    닫을 때까지 백그라운드에서 계속 서버를 두드리게 되므로 상한을 둔다.

    stop()은 메인 스레드에서 호출된다(취소 버튼, 창 닫기). QThread 자체가
    아니라 플래그만 세팅하고, 실제 루프 탈출은 워커 스레드 안에서 다음
    루프 턴에 확인한다 — sleep 중에는 짧은 간격으로 쪼개 깨어나서
    (0.2초 단위) 취소 반응성을 확보한다.
    """

    status_changed = pyqtSignal(dict)  # pending이 아닌 최종 상태
    timed_out = pyqtSignal()
    poll_failed = pyqtSignal(str)  # 조회 자체가 계속 실패할 때(네트워크 등)

    POLL_INTERVAL_SECONDS = 2
    MAX_SECONDS = 60
    SLEEP_TICK_SECONDS = 0.2

    def __init__(self, client, reference_id):
        super().__init__()
        self._client = client
        self._reference_id = reference_id
        self._stopped = False

    def stop(self):
        self._stopped = True

    def _sleep_interruptible(self, seconds):
        elapsed = 0.0
        while elapsed < seconds and not self._stopped:
            time.sleep(self.SLEEP_TICK_SECONDS)
            elapsed += self.SLEEP_TICK_SECONDS

    def run(self):
        started_at = time.monotonic()
        consecutive_errors = 0
        while not self._stopped:
            if time.monotonic() - started_at >= self.MAX_SECONDS:
                self.timed_out.emit()
                return
            try:
                result = self._client.get_status(self._reference_id)
                consecutive_errors = 0
            except ApiError as exc:
                consecutive_errors += 1
                # 한두 번 실패는 일시적 네트워크 문제일 수 있으니 조용히
                # 재시도하고, 연달아 실패하면 그때 화면에 알린다.
                if consecutive_errors >= 3:
                    self.poll_failed.emit(str(exc))
                    return
                self._sleep_interruptible(self.POLL_INTERVAL_SECONDS)
                continue

            status = result.get("status")
            if status != "pending":
                self.status_changed.emit(result)
                return

            self._sleep_interruptible(self.POLL_INTERVAL_SECONDS)

        # self._stopped 상태로 루프를 빠져나온 경우(취소/창 닫기) — 이미
        # 취소 API 호출은 호출부(main.py)에서 별도로 처리하므로 여기서는
        # 아무 시그널도 보내지 않고 조용히 스레드를 종료한다.


def run_in_thread(worker):
    """QObject 워커를 새 QThread로 옮기고 started -> run 만 연결해서 돌려준다.
    **스레드를 시작(start)하지도, 정리(quit/deleteLater)하지도 않는다** — 그건 호출부 책임이다.

    왜 여기서 정리까지 안 하는가: 워커마다 "끝났다"를 알리는 시그널이 다르다
    (SendCartWorker는 succeeded/failed, PollStatusWorker는 status_changed/timed_out/poll_failed).
    이 함수는 그걸 알 수 없으므로, 호출부가 자기 워커의 종료 시그널 전부에 thread.quit과
    worker.deleteLater를 연결해야 한다. 빠뜨리면 스레드가 이벤트 루프를 물고 살아남는다.

    또한 반환된 thread를 어딘가에 보관하지 않으면 가비지 컬렉션 타이밍에 따라 죽은 스레드에서
    경고나 크래시가 난다 — main.py의 _register_thread가 그 보관과 창 종료 시 정리를 맡는다."""
    thread = QThread()
    worker.moveToThread(thread)
    thread.started.connect(worker.run)
    return thread

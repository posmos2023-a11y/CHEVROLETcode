# -*- coding: utf-8 -*-
"""
설정 로드/저장.

우선순위: 환경변수 > config.ini > (config.ini도 없으면) config.example.ini를
복사해서 새로 만든 config.ini의 값.

config.ini에는 ERP 토큰(비밀값)이 들어가므로 저장소에 커밋되면 안 된다 —
루트 .gitignore에 erp-simulator/config.ini를 등록해뒀다. config.example.ini는
토큰 칸을 비운 템플릿이라 커밋해도 안전하다.
"""

import configparser
import os
import sys

BASE_DIR = os.path.dirname(os.path.abspath(__file__))


def resource_dir():
    """번들에 함께 넣은 **읽기 전용** 파일(style.qss, config.example.ini)이 있는 곳.

    PyInstaller로 묶으면 실행할 때마다 임시 폴더에 압축을 풀고 그 경로를 sys._MEIPASS에
    넣어준다. 그때 __file__은 그 임시 폴더를 가리키므로 읽기 전용 리소스는 여기서 찾으면 된다.
    묶지 않고 소스로 실행할 때는 그냥 이 파일이 있는 폴더다."""
    return getattr(sys, "_MEIPASS", BASE_DIR)


def data_dir():
    """사용자가 저장한 값(config.ini)이 **남아 있어야 하는** 곳.

    resource_dir()에 쓰면 안 된다 — PyInstaller onefile은 임시 폴더를 종료할 때 지우기 때문에,
    설정을 저장해도 다음 실행에서 사라진다(ERP 토큰을 매번 다시 입력하게 된다).
    묶인 상태에서는 exe가 있는 폴더에 둔다."""
    if getattr(sys, "frozen", False):
        return os.path.dirname(sys.executable)
    return BASE_DIR


CONFIG_PATH = os.path.join(data_dir(), "config.ini")
EXAMPLE_CONFIG_PATH = os.path.join(resource_dir(), "config.example.ini")

DEFAULT_BASE_URL = "https://chevrolet-api-813801981857.asia-northeast3.run.app"
DEFAULT_STORE_CODE = "CHV-001"

ENV_BASE_URL = "CHEVROLET_API_BASE_URL"
ENV_ERP_TOKEN = "CHEVROLET_ERP_TOKEN"
ENV_STORE_CODE = "CHEVROLET_STORE_CODE"


def _ensure_config_file_exists():
    """config.ini가 없으면 example을 복사해 만든다. 앱을 처음 받은 사람이
    바로 실행했을 때 FileNotFoundError로 죽는 대신, 빈 토큰으로라도 뜨게
    하기 위함 — 토큰은 어차피 설정 다이얼로그에서 나중에 채우면 된다."""
    if os.path.exists(CONFIG_PATH):
        return
    parser = configparser.ConfigParser()
    if os.path.exists(EXAMPLE_CONFIG_PATH):
        parser.read(EXAMPLE_CONFIG_PATH, encoding="utf-8")
    if "api" not in parser:
        parser["api"] = {}
    parser["api"].setdefault("base_url", DEFAULT_BASE_URL)
    parser["api"].setdefault("erp_token", "")
    parser["api"].setdefault("store_code", DEFAULT_STORE_CODE)
    with open(CONFIG_PATH, "w", encoding="utf-8") as f:
        parser.write(f)


class Config:
    def __init__(self, base_url, erp_token, store_code):
        self.base_url = base_url
        self.erp_token = erp_token
        self.store_code = store_code


def load_config():
    """config.ini를 읽되, 환경변수가 있으면 그 값으로 덮어쓴다.
    (배포/CI 환경에서는 config.ini 없이 환경변수만으로 돌릴 수 있어야 하므로
    환경변수를 항상 우선한다.)"""
    _ensure_config_file_exists()

    parser = configparser.ConfigParser()
    parser.read(CONFIG_PATH, encoding="utf-8")
    section = parser["api"] if "api" in parser else {}

    base_url = section.get("base_url", DEFAULT_BASE_URL) if section else DEFAULT_BASE_URL
    erp_token = section.get("erp_token", "") if section else ""
    store_code = section.get("store_code", DEFAULT_STORE_CODE) if section else DEFAULT_STORE_CODE

    base_url = os.environ.get(ENV_BASE_URL, base_url)
    erp_token = os.environ.get(ENV_ERP_TOKEN, erp_token)
    store_code = os.environ.get(ENV_STORE_CODE, store_code)

    return Config(base_url=base_url.strip(), erp_token=erp_token.strip(), store_code=store_code.strip())


def save_config(config):
    """설정 다이얼로그에서 [저장]을 누르면 config.ini에 반영한다.
    환경변수가 우선한다는 사실은 다이얼로그 쪽 안내 문구로 알려주고,
    여기서는 파일 저장만 신경 쓴다(환경변수를 건드리는 건 이 프로세스
    권한 밖이라 불가능하기도 하다)."""
    parser = configparser.ConfigParser()
    parser["api"] = {
        "base_url": config.base_url,
        "erp_token": config.erp_token,
        "store_code": config.store_code,
    }
    with open(CONFIG_PATH, "w", encoding="utf-8") as f:
        parser.write(f)

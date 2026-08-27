#!/bin/sh
# 컨테이너 부팅 스크립트.
#
# 마이그레이션을 실행할지 여부(RUN_MIGRATIONS_ON_BOOT)는 Dockerfile 주석에 설명이 있다.
# 이 스크립트가 추가로 하는 일은 그와 별개의 문제다: `prisma migrate deploy`가 실패했을 때
# "advisory lock 경합에서 졌을 뿐"인지 "마이그레이션이 정말로 깨졌는지"를 구분하는 것.
#
# Cloud Run처럼 여러 인스턴스가 동시에 콜드스타트하는 환경에서는, 먼저 락을 잡은 인스턴스가
# 마이그레이션을 적용하는 동안 나머지 인스턴스들의 `migrate deploy`는 락 대기/충돌로 실패할 수
# 있다. 이건 정상적인 상황이다 — 락을 잡은 다른 인스턴스가 곧 스키마를 최신으로 만들어 줄
# 것이기 때문이다. 그런데 이 실패를 그냥 `exit 1`로 처리하면 그 인스턴스는 기동에 실패하고,
# Cloud Run이 재시작을 반복하면서 크래시 루프에 빠진다(모든 인스턴스가 트래픽을 못 받는
# 전면 장애).
#
# 그래서 `migrate deploy`가 실패하면 곧바로 죽지 않고 `migrate status`로 스키마가 실제로
# 최신인지 다시 확인한다.
#   - 최신이면(= `migrate status`가 exit 0으로 끝남, "Database schema is up to date!") →
#     락 경합에서 졌을 뿐이니 서버를 그대로 띄운다.
#   - 아직 적용 안 된 마이그레이션이 남아있으면(= `migrate status`가 non-zero exit) →
#     5초 간격으로 최대 3번까지 다시 확인한다(락을 잡은 인스턴스가 아직 적용 중일 수 있다).
#     그래도 최신이 아니면 진짜로 깨진 것이니 exit 1로 죽는다. 잘못된(구버전) 스키마로 서버가
#     뜨는 건 크래시 루프보다 나쁘다 — 데이터 정합성이 깨질 수 있다.
set -e

if [ "$RUN_MIGRATIONS_ON_BOOT" = "true" ]; then
  if ! npx prisma migrate deploy; then
    echo "docker-entrypoint: migrate deploy failed - running migrate status to tell lock contention from a real failure" >&2

    # 판단 시점에 락을 잡은 인스턴스가 아직 적용 중일 수 있다. 그때 status는 당연히
    # "아직 안 됐다"고 답하는데, 그걸 진짜 실패로 보고 곧바로 죽으면 결국 재시작을 한 바퀴
    # 돌아야 한다 - 크래시 루프까지는 아니어도 기동이 그만큼 늦어진다.
    # 그래서 잠깐 기다리며 몇 번 더 확인한다. 상한을 두는 이유는 Cloud Run의 기동 제한시간
    # 안에 반드시 포트를 열어야 하기 때문이다 - 무한정 기다리면 그것대로 기동 실패다.
    schema_ok=""
    attempt=1
    while [ "$attempt" -le 3 ]; do
      if npx prisma migrate status; then
        schema_ok="yes"
        break
      fi
      # `[ ... ] && sleep 5` 로 쓰면 안 된다. 조건이 거짓일 때 그 줄 전체가 non-zero로 끝나
      # set -e가 스크립트를 죽인다.
      if [ "$attempt" -lt 3 ]; then
        echo "docker-entrypoint: schema not ready yet - another instance may still be applying, retrying in 5s" >&2
        sleep 5
      fi
      attempt=$((attempt + 1))
    done

    if [ -n "$schema_ok" ]; then
      echo "docker-entrypoint: schema is up to date - lost the lock race to another instance, continuing boot" >&2
    else
      echo "docker-entrypoint: schema is still not up to date after retries - migration genuinely failed, exiting" >&2
      exit 1
    fi
  fi
fi

# 반드시 exec여야 한다 — Dockerfile 주석 참고(PID 1과 SIGTERM, graceful shutdown).
exec node server.js

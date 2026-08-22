# CODEXOFFICE_DEVELOPMENT_PLAN_2026-08-18.md

## 1. 기준과 목적

- 기준 커밋: `0629c5a932ddd49ed3bbaf6d6425df214a584969`
- 기간: 2026-08-18부터 2~4주
- 목적: 현재 기능을 재작성하지 않고 데이터 안전성, 재현 가능한 검증, macOS 배포 및 운영 통제를 갖춘 Release Candidate로 만든다.

### 확인 사실

- 로컬 Node 20 검증:
  - lint 오류 0
  - typecheck PASS
  - build PASS
  - Electron E2E 15/15 PASS
  - 주요 단위 테스트 PASS
- 공개 CI는 Node 22/Linux에서 macOS 전용 패키징 로직 때문에 실패한다.
- PDF 변환은 격리 renderer, 별도 파일 프로토콜, 타임아웃을 이미 사용한다.
- PDF 복구본·잔존 잠금, 메모리 방어심층, clean 설치, 실제 오피스 호환성, macOS 배포 및 AI 비용 통제는 추가 증거가 필요하다.

### 추론

- 핵심 기능의 기본 회귀 품질은 양호하다.
- PDF 메모리는 현재 즉시 차단보다는 방어심층 잔여 위험이지만 OOM, UI 정지, renderer 잔존이 재현되면 릴리스 차단으로 승격한다.
- 복구본 오인·정상본 덮어쓰기는 데이터 손실 위험이고, stale lock으로 저장이 막히는 것은 가용성 위험이다.

## 2. 목표와 비목표

### 목표

1. 필수 검사를 유지한 채 공개 CI를 정상화한다.
2. PDF 저장 실패와 강제종료에서도 원본을 보호하고 stale lock을 복구한다.
3. clean Node 20 설치, 의존성 감사, 메모리·호환성·배포 증거를 확보한다.
4. AI 호출 비용과 남용을 계정 단위로 제한한다.

### 비목표

이번 2~4주에는 다음을 구현하지 않는다.

- PDF 파이프라인 전면 재작성
- 분산 lock 또는 DB 기반 lock
- 범용 자원 스케줄러
- OCR, 진짜 redaction, 암호학적 서명, PDF 접근성 확장

## 3. 우선순위

| 등급 | 항목                          | 완료 목표                                          |
| ---- | ----------------------------- | -------------------------------------------------- |
| P0   | 공개 CI                       | Linux 공통 검증과 macOS 패키징을 분리해 전체 green |
| P0   | PDF 저장·잠금                 | 원본 보존, 복구본 식별, stale lock 자동 회수       |
| P0   | clean Node20·승인 온라인 감사 | 새 checkout에서 재현 가능한 설치와 전체 검증       |
| P1   | PDF 메모리 방어심층           | 반복 변환·타임아웃·프로세스 정리 증명              |
| P1   | Office·LibreOffice 호환성     | 대표 fixture의 열기·편집·재저장 검증               |
| P1   | macOS 배포                    | 서명·공증·Gatekeeper·업데이트 성공                 |
| P1   | AI 비용·남용 통제             | 상한, 알림, 차단, 감사 로그                        |
| P2   | 전문 PDF 기능                 | 별도 제품 요구사항과 보안 검토 후 착수             |

## 4. 1~4주 실행순서

### 1주차 — P0 검증선 복구

**A. 공개 CI 수정**

- 담당: Release/CI Engineer
- 노력: 0.5~1일
- 의존성: 없음
- 모듈 후보: `.github/workflows/*`, Electron/package 스크립트
- 구현: Linux Node 22에서는 lint·typecheck·build·test를 모두 실행하고, macOS 전용 패키징만 `runner.os == 'macOS'` 또는 별도 macOS job으로 제한한다.
- 수용 기준: 공개 CI green, 기존 필수 테스트 수와 명령 유지, macOS 산출물 경로 불변.
- 금지: `continue-on-error`, `|| true`, 필수 test skip 또는 조건부 우회.

**B. PDF 저장·잠금**

- 담당: Electron/PDF Engineer
- 노력: 2~3일
- 의존성: 저장·복구 계약 확인
- 모듈 후보: PDF export/save, temp/recovery, file lock, IPC/file protocol
- 구현: 임시 파일 기록→검증→원자적 교체, 복구본 명명·표시, active lock 보호, stale lock 만료·회수.
- 수용 기준: 저장 중 강제종료 후 원본 보존, 복구본 명시, 재실행 후 lock 회수 및 재저장 성공.
- HOLD: 원본 손실, 무음 덮어쓰기, 정상 lock 오회수, 재저장 불가.

### 2주차 — 재현성과 안정성

**C. clean Node 20 및 승인된 온라인 의존성 감사**

- 담당: Build/Security Engineer
- 노력: 1~2일
- 의존성: lockfile, 승인 목록
- 모듈 후보: `package.json`, lockfile, install/postinstall, 다운로드 코드
- 수용 기준: 깨끗한 checkout에서 lockfile 기반 install→lint→typecheck→build→unit/integration/E2E 통과; 설치 중 온라인 접근, 바이너리 다운로드, telemetry를 목록화하고 승인 여부 기록.
- HOLD: lockfile 불일치, 출처 불명 패키지, 미승인 install script 또는 외부 다운로드.

**D. PDF 메모리 방어심층**

- 담당: Electron Engineer/QA
- 노력: 1~2일
- 의존성: 대표 최대 문서 fixture
- 모듈 후보: 격리 renderer, export worker, timeout/cleanup
- 수용 기준: 최대 지원 문서 20회 연속 변환, 메인 UI 응답 유지, 타임아웃 시 renderer 종료, 좀비 프로세스 없음, 종료 후 RSS가 정의된 기준선 범위로 회복.
- HOLD: OOM, 메인 프로세스 종료, 지속 증가, renderer 잔존.

### 3주차 — 실제 호환성과 배포

**E. Microsoft Office·LibreOffice QA**

- 담당: QA/Product
- 노력: 2~3일
- 의존성: 실제 앱 설치 및 대표 fixture
- 모듈 후보: Sheets/Slides/문서 import-export
- 수용 기준: 각 앱에서 열기→편집→저장→재열기 수행, 본문·수식·표·이미지·기본 서식 보존 결과표 작성.
- HOLD: 파일 손상, 핵심 콘텐츠 유실, 사용자 경고 없는 중대한 비호환.

**F. macOS 서명·공증·업데이트**

- 담당: Release Engineer
- 노력: 2~3일
- 의존성: Apple Developer ID, 공증 자격증명, 업데이트 서명키·호스팅
- 모듈 후보: Electron builder 설정, entitlements, updater/release workflow
- 수용 기준: clean Mac에서 다운로드·설치, Gatekeeper 무경고 실행, notarization 확인, 이전 버전에서 서명된 업데이트 및 실패 시 안전 복귀.
- HOLD: 우회 실행 필요, 공증 실패, 서명 불일치, 업데이트 검증 실패.

### 4주차 — 운영 통제와 RC

**G. AI 비용·남용 통제**

- 담당: Platform/Backend Engineer
- 노력: 1~2일
- 의존성: provider/account별 예산·과금 API 또는 내부 계량
- 모듈 후보: provider adapter, usage ledger, account settings, alerting
- 수용 기준: 계정별 일·월 상한, 80/100% 알림, 초과 시 fail-closed 차단, 재시도 폭주 제한, 요청량·비용·차단 사유 감사 로그.
- HOLD: 상한 없는 유료 호출, 키의 renderer 노출, 차단 우회 가능.

**H. RC 회귀**

- 전체 unit, integration, Electron E2E, 수동 QA를 다시 실행하고 결과·알려진 제한·릴리스 노트를 기준 커밋과 연결한다.

## 5. 테스트 매트릭스

- Unit: 저장 상태 전이, lock 판정, recovery 선택, timeout, 비용 계산·상한.
- Integration: 임시 파일→교체, crash recovery, stale lock 회수, renderer 정리, provider 차단.
- Electron E2E: 기존 15/15 유지 + 저장 강제종료, 재실행 복구, PDF timeout, 업데이트 smoke.
- 수동 QA: 실제 Microsoft Office·LibreOffice 및 clean macOS에서 설치·열기·편집·재저장·업데이트.
- 모든 실패는 재현 fixture, 로그, 기대값과 함께 보관한다.

## 6. 코드 작업과 외부 게이트

### 코드로 완료 가능

CI 분리, 저장·lock 최소 수정, 테스트 추가, 메모리 cleanup 검증, 비용 상한·로그, 의존성 목록화.

### 외부 게이트

Apple Developer ID·공증 계정, 업데이트 서명키·배포 서버, AI provider/account·결제 한도, 실제 Microsoft Office·LibreOffice, clean Mac 실기기 검증. 자격증명 미제공 시 관련 기능은 완료 처리하지 않고 기본 비활성 또는 릴리스 HOLD로 둔다.

## 7. 롤백·장애 대응

- 배포 전 이전 서명 버전과 업데이트 manifest를 보존한다.
- 설치/업데이트 장애: 채널 중지→이전 버전 manifest 복원→원인 격리.
- PDF 저장 장애: 자동 재시도보다 원본·복구본 보존을 우선하고 사용자에게 파일 위치와 선택지를 표시한다.
- AI 비용 이상: provider 호출 즉시 차단, 키 회전, 사용 로그·계정별 비용 확인.
- 데이터 손실 가능성이 있으면 전체 릴리스를 즉시 HOLD한다.

## 8. 잔여 위험

- Node 20 로컬과 Node 22 CI 차이
- 극단적으로 큰 문서의 OS 전체 메모리 압박
- Office 구현체별 비표준 서식 차이
- 공증·업데이트 인프라 및 외부 계정 의존성
- 전문 PDF 기능 부재로 인한 사용자 기대 불일치

## 9. Definition of Done

- 공개 CI 전체 green이며 필수 검사가 우회되지 않음
- clean Node 20 전체 검증 PASS 및 승인 온라인 감사 기록 완료
- PDF 원본 보존·복구본 식별·stale lock 회수 PASS
- PDF 반복/timeout/메모리 기준 PASS
- unit/integration/Electron E2E 전부 PASS
- Office·LibreOffice 결과표와 알려진 제한 승인
- macOS 서명·공증·Gatekeeper·업데이트 PASS
- AI 상한·알림·차단·로그 PASS
- 롤백 절차와 HOLD 책임자 확정

## 10. 실행 체크리스트

- [ ] Linux 공통 CI와 macOS 패키징 job 분리
- [ ] 필수 테스트 우회가 없는지 리뷰
- [ ] PDF 원자 저장·복구본·stale lock 검증
- [ ] clean Node 20 전체 검증
- [ ] 승인된 온라인 의존성 감사
- [ ] PDF 20회 반복·timeout·renderer 정리 검증
- [ ] Microsoft Office 수동 QA
- [ ] LibreOffice 수동 QA
- [ ] Developer ID 서명·공증·Gatekeeper 검증
- [ ] 서명된 업데이트와 롤백 검증
- [ ] AI 계정별 상한·알림·차단 검증
- [ ] RC 전체 회귀 및 Go/No-Go 승인

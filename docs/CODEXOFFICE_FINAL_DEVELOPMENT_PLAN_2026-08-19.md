# CodexOffice 최종 개발 계획서

## 1. 기준

- 브랜치: `agent/codex-sdk`
- 기준 HEAD: `dd49879245d47abec98396fc485b414d1c45b104`
- GitHub Actions: run `32150644331`
- 계획 기간: 2~4주
- 목표 상태: 기능 재작성 없이 검증 가능하고 롤백 가능한 macOS Release Candidate
- 검토 대화: GPT-5.6 Sol Pro 기존 `진행상황과 위험평가` 대화

## 2. 현재 사실과 추론

### 확인된 사실

- GitHub Actions의 `e2e` job은 성공했다.
- `test` job은 마지막 `Test` 단계에서 실패했다.
- 실패 지점은 `apps/shell/tests/mac-release-gates.test.ts` 수집 중이다.
- `tools/codex-electron-runtime.cjs`의 `resolveCodexBuildRuntime`이 CI 호스트 `linux-x64`를 `Unsupported Codex packaging target`으로 거부했다.
- 그 전 install, license, formatting, lint, typecheck, fixtures는 모두 성공했다.
- Sheets compatibility gate는 앞선 test 실패로 skipped 됐다.
- 로컬 Node 20 호환성 실행에서는 전체 검증과 Electron E2E 15/15가 통과했지만, 현재 root와 Electron 41의 지원 계약은 Node `>=22.12.0`이다.
- PDF 저장 경로에는 이미 `conditional-write.ts`, `guarded-save.ts` 및 crash/lock 테스트가 존재한다.
- PDF 변환은 격리 renderer, 별도 파일 프로토콜, 타임아웃을 사용한다.

### 추론

- 현재 CI 실패는 제품 기능 실패보다 macOS 패키징 계약 테스트가 Linux 호스트를 암묵적으로 읽는 결합에 가깝다.
- PDF 메모리 상한 부재는 현재 즉시 차단보다 방어심층 잔여 위험이다. OOM, UI 정지, renderer 잔존이 재현되면 차단으로 승격한다.
- 복구본이 정상본을 덮거나 오인되는 문제는 데이터 손실 위험이고, stale lock으로 저장이 막히는 문제는 가용성 위험이다.

## 3. 목표와 비목표

### 목표

1. 필수 검사를 생략하지 않고 Linux/macOS CI 의미를 모두 보존한다.
2. PDF 원본 보존, 복구본 식별, lock 회수 가능성을 증명한다.
3. clean Node 22.12 설치와 승인된 온라인 의존성 감사를 완료한다.
4. 실제 Office 호환성, macOS 배포, AI 비용 통제 증거를 확보한다.
5. 각 변경을 독립 커밋으로 만들어 실패 시 부분 롤백할 수 있게 한다.

### 비목표

- PDF 파이프라인 전면 재작성
- 분산 lock 또는 DB 기반 lock
- 범용 자원 스케줄러
- OCR, 진짜 redaction, 암호학적 PDF 서명, PDF 접근성 확장
- CI 성공을 위한 test skip, `continue-on-error`, `|| true`

## 4. 우선순위

| 등급 | 항목                       | 핵심 완료 증거                          |
| ---- | -------------------------- | --------------------------------------- |
| P0   | CI release gate 수정       | Linux test와 macOS 계약 검증 모두 green |
| P0   | PDF pre-replace crash 검증 | 원본 보존 및 다음 저장 성공             |
| P0   | clean Node22·온라인 감사   | 새 checkout 전체 검증 및 승인 기록      |
| P1   | PDF 메모리 방어심층        | 반복 변환 후 UI·프로세스·RSS 안정       |
| P1   | Office·LibreOffice QA      | 대표 문서 열기·편집·재저장 결과표       |
| P1   | macOS 배포                 | 서명·공증·Gatekeeper·업데이트 성공      |
| P1   | AI 비용·남용 통제          | 상한·알림·차단·감사 로그                |
| P2   | 전문 PDF 기능              | 별도 요구사항·보안 설계 후 착수         |

## 5. 실행 순서

### 1주차: CI 최소 안전 수정

대상 파일:

- `tools/codex-electron-runtime.cjs`
- `apps/shell/tests/mac-release-gates.test.ts`
- 필요한 경우에만 `.github/workflows/ci.yml`
- 계약 확인 전용: `apps/shell/build/electron-builder-config.js`, `apps/shell/electron-builder.cjs`

함수 경계:

- `resolveCodexBuildRuntimeForTarget(platform, arch)` 순수 함수를 추가한다.
- 기존 `resolveCodexBuildRuntime()`는 인자 없는 production wrapper로 유지하고 `process.platform`, `process.arch`를 순수 함수에 전달한다.
- builder config와 production 호출부는 기존 wrapper를 계속 사용한다.

Linux assertion:

- `darwin-arm64`, `darwin-x64`가 승인된 runtime/package/artifact 매핑과 일치한다.
- 두 타깃의 아키텍처 의존 경로가 서로 다르고 필수 필드가 비어 있지 않다.
- `linux-x64`는 정확히 `Unsupported Codex packaging target: linux-x64`를 throw한다.
- 모듈 import 또는 test collection만으로 현재 Linux 호스트를 해석하지 않는다.

macOS assertion:

- production wrapper 결과가 현재 Mac의 명시적 `darwin-*` 결과와 동일하다.
- 실제 builder 설정이 production wrapper를 사용하며 기존 산출물 계약을 유지한다.

수용 기준:

- install, license, formatting, lint, typecheck, fixtures, test, Sheets compatibility gate가 모두 실행된다.
- 기존 E2E 성공과 테스트 수가 유지된다.
- Linux를 지원 패키징 타깃으로 잘못 허용하지 않는다.

HOLD:

- test skip 또는 조건부 우회
- production wrapper 제거
- Linux 패키징 허용
- macOS runtime/artifact 계약 변경
- Sheets compatibility 재차 skipped

### 1~2주차: PDF 최소 수직 조각

대상 파일:

- `apps/pdf/src/main/conditional-write.ts`
- `apps/pdf/src/main/guarded-save.ts`
- `apps/pdf/tests/guarded-save.test.ts`

기존 저장·lock 구현은 재작성하지 않는다. 필요한 경우에만 가장 좁은 내부 함수 경계에 테스트용 fault seam을 둔다.

Fault injection:

- 임시 파일 write → fsync → close 완료 후 atomic replace 직전에 예외를 주입한다.

수용 기준:

- 기존 대상 파일의 바이트 또는 해시가 변하지 않는다.
- 임시 파일·복구본이 정상 대상 파일로 오인되지 않는다.
- active lock을 stale lock으로 잘못 회수하지 않는다.
- 재실행 또는 다음 저장에서 stale 상태가 정리되고 저장에 성공한다.
- 사용자 확인 없이 복구본이 정상본을 덮어쓰지 않는다.

HOLD:

- 원본 변경 또는 삭제
- 무음 덮어쓰기
- 임시 파일을 정상본으로 노출
- lock 영구 잔존
- 다음 저장 실패

### 2주차: clean Node 22.12와 승인 온라인 감사

- 깨끗한 checkout과 Node 22.12에서 lockfile 기반 설치를 수행한다.
- lint, typecheck, build, unit, integration, Electron E2E를 모두 실행한다.
- 설치 중 외부 접속, 바이너리 다운로드, telemetry, provider SDK를 목록화한다.
- 각 온라인 의존성에 목적·도메인·버전·승인자를 기록한다.

HOLD: lockfile 불일치, 출처 불명 바이너리, 미승인 install script·네트워크 호출, 숨은 필수 환경값.

### 2~3주차: PDF 메모리 방어심층

- 최대 지원 문서를 20회 연속 변환한다.
- 메인 UI 응답, timeout 시 격리 renderer 종료, 좀비 프로세스 부재를 확인한다.
- 작업 종료 후 RSS가 사전 정의한 기준선 범위로 회복되어야 한다.

HOLD: OOM, UI 정지, renderer 잔존, 지속적인 메모리 증가, timeout 후 파일·lock 잔존.

### 3주차: Office 호환성과 macOS 배포

Microsoft Office·LibreOffice QA:

- 대표 fixture를 열기 → 편집 → 저장 → 재열기 한다.
- 본문, 표, 수식, 이미지, 기본 서식, 페이지·슬라이드 구조를 비교한다.
- 앱별 결과표와 사용자 영향·우회 방법을 문서화한다.

macOS 배포:

- clean Mac에서 다운로드·설치하고 Gatekeeper 우회 없이 실행한다.
- notarization을 확인하고 이전 서명 버전에서 업데이트한다.
- 서명 불일치·다운로드 실패 시 기존 버전을 보존한다.

### 4주차: AI 통제와 RC

- 계정별 일·월 비용 또는 요청 상한을 적용한다.
- 80% 경고, 100% fail-closed 차단, 재시도·동시 요청 제한을 검증한다.
- 요청량·예상 비용·차단 사유를 민감정보 없이 기록한다.
- API 키가 renderer, 로그, 배포 산출물에 노출되지 않아야 한다.

## 6. 커밋 분리

1. `fix(ci): make Codex runtime release gates target-explicit`
   - runtime 순수 resolver
   - production wrapper 보존
   - Linux/macOS assertion
   - 필요한 최소 CI 조정
2. `test(pdf): cover crash immediately before atomic replace`
   - fault seam과 negative test
   - 기존 저장·lock 로직 재작성 금지
3. 테스트가 실제 결함을 드러낼 때만 `fix(pdf): preserve original and recover after pre-replace failure`

CI와 PDF를 한 커밋에 섞지 않는다.

## 7. 테스트 체계

- Unit: runtime target 매핑, lock 판정, recovery 선택, 비용 상한
- Integration: temp-write/fsync/replace, crash recovery, stale lock 회수, renderer cleanup
- Electron E2E: 기존 15/15 유지, 저장 실패·재실행·PDF timeout smoke 추가
- 실제 QA: Microsoft Office, LibreOffice, clean macOS 설치·Gatekeeper·업데이트
- 실패 증거: fixture, 실행 명령, 로그, 기대값, 실제값을 커밋 또는 CI artifact와 연결

## 8. 코드 작업과 외부 게이트

### 코드로 완료 가능

- target-explicit resolver와 테스트
- CI job 조건 정리
- PDF fault seam·negative test와 최소 결함 수정
- 메모리 반복 테스트
- AI 상한·로그·차단
- 의존성 목록화

### 외부 게이트

- Apple Developer ID와 공증 계정
- 업데이트 서명키·배포 서버
- 실제 Microsoft Office·LibreOffice
- clean Mac 실기기
- AI provider/account·결제 한도

외부 자격증명이나 수동 QA가 없으면 해당 항목은 완료 처리하지 않는다. 관련 기능은 기본 비활성 또는 릴리스 HOLD로 둔다.

## 9. 롤백과 장애 대응

- 각 커밋은 독립 revert 가능해야 한다.
- CI 수정 실패 시 resolver/test 커밋만 되돌리고 기존 production 패키징 경로를 유지한다.
- PDF 결함 시 배포를 중단하고 원본·복구본을 보존하며 자동 덮어쓰기를 금지한다.
- 업데이트 장애 시 채널을 중지하고 이전 manifest와 서명 버전을 복원한다.
- AI 비용 이상 시 provider 호출을 차단하고 키 회전과 사용 로그 점검을 수행한다.
- 데이터 손실 가능성이 한 번이라도 확인되면 전체 릴리스를 HOLD한다.

## 10. 잔여 위험

- Node 20 호환성 실행과 지원 기준인 Node 22.12 환경 차이
- 극단적 대형 PDF의 OS 전체 메모리 압박
- Office 구현체별 비표준 서식
- 외부 서명·공증·업데이트 인프라
- provider 과금 지연으로 인한 비용 추정 오차
- 전문 PDF 기능 부재에 대한 사용자 기대 불일치

## 11. Definition of Done

- run `32150644331`의 실패 원인이 재현 테스트로 고정되고 후속 CI가 green이다.
- Linux에서 macOS 두 타깃의 계약과 `linux-x64` 거부를 검증한다.
- macOS에서 production wrapper와 실제 패키징 계약을 검증한다.
- 필수 CI 단계와 Sheets compatibility gate가 모두 실행된다.
- PDF pre-replace crash에서 원본을 보존하고 다음 저장에 성공한다.
- clean Node 22.12 전체 검증과 승인 온라인 감사를 완료한다.
- PDF 메모리 기준과 unit/integration/Electron E2E를 통과한다.
- 실제 Office·LibreOffice QA가 승인된다.
- macOS 서명·공증·Gatekeeper·업데이트를 통과한다.
- AI 상한·알림·차단·로그를 검증한다.
- 롤백 절차와 Go/No-Go 책임자를 확정한다.

## 12. 2026-08-19 실행 증거

- 지원 기준을 root와 Electron 41 계약에 맞춰 Node 22.12로 통일했다. Node 20은 호환성 확인에만 사용한다.
- Node 22.23.2에서 `npm ci` clean install이 성공했다.
- lint는 오류 0건이며 기존 React Hook 경고 8건만 남았다.
- 전체 typecheck, unit/integration test, `build:all`이 통과했다.
- 실제 Electron E2E는 sandbox 밖 전체 재실행에서 17/17 통과했다.
- LibreOffice 구조 round-trip corpus는 DOCX/XLSX/PPTX 3/3 통과했다.
- 온라인 `npm audit --omit=dev`와 전체 `npm audit`는 `nanoid`를 3.3.18로 올린 뒤 모두 0건이다.
- GitHub Actions의 test/e2e/Sheets compatibility가 모두 통과했고 CI와 PDF 수정은 독립 커밋으로 분리했다.
- 실제 Electron에서 PDF 저장을 20회 연속 실행해 매 작업 뒤 숨은 renderer와 `genoffice-pdf-job-*` staging이 기준 상태로 복귀하고, 최종 RSS가 기준선 +256 MiB 및 5회차 +128 MiB 이내임을 검증했다.
- 입력 staging 중 1 ms timeout이 먼저 발생하면 중단된 `run()`이 나중에 숨은 창을 만들 수 있던 경쟁을 닫았다. 실제 timeout E2E는 원본 byte 보존, renderer·창·staging 정리, shell 생존을 검증한다.
- PDF commit journal은 v2에서 PID와 OS 프로세스 생성 세대를 함께 기록한다. 같은 PID가 재사용돼도 생성 세대가 다르면 복구하고, 정확히 일치하거나 확인할 수 없으면 fail-closed한다.
- AI request ledger v2는 승인된 요청의 예약 토큰과 비식별 allow/deny 사유를 0600 원자 저장하고, 반복 거부 로그를 분당 사유별 한 건으로 합쳐 로컬 I/O 남용을 제한한다.
- macOS release preflight는 provider hard cap, 80% 이하 경고, fresh kill switch, multi-client 합산, 비식별 비용 로그를 정확한 source SHA와 결속한 증거가 없으면 HOLD한다.
- 전체 회귀는 JavaScript/TypeScript 3,875 PASS / 2 skip, Sheets Rust 53/53, Electron E2E 17/17, LibreOffice 구조 round-trip 3/3, build/typecheck/format/diff-check PASS다.
- 보안 diff scan `d0bedaae-5376-4e60-ad0b-bcd8291d9c3d`은 변경 보안 표면 전체를 검토했고 보고 가능한 finding 0건으로 완료됐다.

## 13. 실행 체크리스트

- [x] `resolveCodexBuildRuntimeForTarget(platform, arch)` 추가
- [x] 인자 없는 production wrapper 보존
- [x] Linux에서 `darwin-arm64`/`darwin-x64` 매핑 assertion
- [x] Linux에서 `linux-x64` 정확한 거부 assertion
- [x] macOS wrapper와 명시 target 동등성 검증
- [x] 필수 CI 검사 및 Sheets compatibility 실행 확인
- [x] PDF atomic replace 직전 fault injection
- [x] 원본 해시·복구본·lock·다음 저장 검증
- [x] CI와 PDF 커밋 분리
- [x] clean Node 22.12 전체 검증
- [x] 승인 온라인 의존성 감사 (production/full 0건, `nanoid` 3.3.18 반영 후 재검증)
- [x] PDF 20회 반복·timeout·RSS·renderer 검증
- [x] 로컬 AI 토큰 상한·kill switch·비식별 허용/차단 감사 로그
- [x] provider 운영 증거 검증기와 macOS release fail-closed 연결
- [x] 업데이트 성공·실패 증거 검증기와 macOS release fail-closed 연결
- [ ] Microsoft Office 수동 QA
- [ ] LibreOffice 수동 QA
- [ ] Developer ID 서명·공증·Gatekeeper 검증
- [ ] 서명된 실제 N→N+1 업데이트 성공·실패 롤백 검증
- [ ] AI 비용 상한·알림·차단·키 보호 검증
- [ ] 전체 RC 회귀 및 Go/No-Go 승인

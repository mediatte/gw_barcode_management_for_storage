# clasp_barcode

Google Apps Script 기반 물품 대여/반납 웹앱입니다.  
사용자 정보는 `users` 시트에서 불러오고, 물품 정보는 `items`, 대여 이력은 `rentals` 시트에 기록합니다.

## 구성

- `Code.js`: 서버 로직
- `index.html`: 웹앱 UI
- `appsscript.json`: Apps Script 매니페스트
- `.clasp.json`: 로컬 전용 clasp 연결 정보
- `.clasp.json.example`: Git용 예제 설정

## 기능

- `users` 탭에서 사용자 목록 로드
- 이메일 기준 사용자 식별
- QR/바코드 스캔 및 수동 입력 지원
- `rentals` 최신 미반납 기록 기준 자동 대여/반납 처리
- `items` 상태값 동기화

## 스프레드시트 구조

### `users`

| 연번 | 이름 | 과목 | 이메일 |
| --- | --- | --- | --- |

### `items`

| QR코드 | 물품명 | 설명 | 상태 | 등록일 | 위치 |
| --- | --- | --- | --- | --- | --- |

### `rentals`

| 대여ID | 사용자명 | 이메일 | QR코드 | 물품명 | 대여일 | 반납일 |
| --- | --- | --- | --- | --- | --- | --- |

## 로컬 설정

1. `clasp` 설치

```bash
npm install -g @google/clasp
```

2. 로그인

```bash
clasp login
```

3. `.clasp.json.example`을 참고해 로컬용 `.clasp.json` 생성

4. 필요하면 `Code.js`의 `SPREADSHEET_ID`를 운영 시트 ID로 수정

## 배포

로컬 변경사항을 Apps Script 프로젝트로 올릴 때:

```bash
clasp push
```

배포 목록 확인:

```bash
clasp deployments
```

현재 웹앱이 버전 배포 URL을 쓰고 있다면, `clasp push`만으로는 반영되지 않을 수 있습니다.  
그 경우 Apps Script에서 새 버전으로 다시 배포해야 합니다.

## Git 권장 사항

- `.clasp.json`은 로컬 연결 정보이므로 커밋하지 않음
- `.clasp.json.example`만 저장소에 포함
- 배포용 ID, 개인 계정 정보, 테스트 로그는 커밋하지 않음

# gw_barcode_management_for_storage

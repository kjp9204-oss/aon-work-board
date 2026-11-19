# Google Sheets 저장 준비

이 폴더는 Apps Script 원본입니다. GitHub Pages는 화면만 제공하며 이 코드를 실행하지 않습니다. 실제 Google Sheet, Google Cloud 클라이언트, 웹앱 배포는 운영자가 승인한 뒤 설정합니다.

1. 비공개 Google Sheets 문서를 **AON 오늘의 센터 데이터**로 만들고 확장 프로그램에서 Apps Script를 엽니다. 이 폴더의 Auth.gs, Code.gs, appsscript.json을 붙여 넣습니다. manifest에 지정한 Google Sheets 고급 서비스를 확인합니다. 표준 Cloud 프로젝트를 연결했다면 Google Sheets API도 활성화해야 합니다.
2. Apps Script 편집기에서 **prepareAonSpreadsheet**를 한 번 실행합니다. 비어 있는 탭에만 헤더를 쓰고 업무, 일정, 허용 계정, 변경 기록을 준비합니다. 운영 시트의 ID는 스크립트 속성 AON_SHEET_ID에만 저장됩니다.
3. Google Cloud에서 웹 애플리케이션 OAuth 클라이언트를 만듭니다. 승인된 JavaScript 원본은 https://kjp9204-oss.github.io 입니다. 공개 클라이언트 ID를 Apps Script 스크립트 속성 **AON_GOOGLE_CLIENT_ID**와 프런트 설정에 같은 값으로 지정합니다. 클라이언트 비밀은 사용하지 않습니다.
4. 허용 계정 탭의 email 열에 허용할 Gmail 또는 관리형 Google Workspace 이메일을 기입합니다. 이메일이 없으면 어떤 사용자도 앱을 사용할 수 없습니다. 업무 및 일정 탭을 사용자에게 직접 공유할 필요는 없습니다. 시트에서 업무·일정을 직접 수정하면 웹앱 버전 검사와 이력을 우회하므로 업무 변경은 웹앱에서 합니다.
5. 승인 후 웹앱을 시트 소유자로 실행하고, 브라우저가 로그인 쿠키 없이 접근 가능한 접근 옵션으로 배포합니다. 관리 규칙에서 이 옵션을 허용하지 않는 경우 권한을 낮추거나 인증을 없애지 않고 관리자에게 확인합니다. 배포 URL의 /exec 주소를 프런트 설정에 사용합니다. 최종 게시 전 실제 허용 계정·비허용 계정·두 창 동시 수정과 브라우저 응답 전달을 확인합니다.

## 동작

- 서버는 매 요청마다 Google 서명, 클라이언트 ID, 발급자, 만료, 검증된 이메일을 확인하고 허용 계정 탭을 읽습니다. Google 비관리 도메인의 이메일은 별도 검증 없이 허용하지 않습니다.
- 사용자의 Google 식별자는 시트에서 수정자와 작성자 판별에 사용합니다. OAuth 토큰, 고객 정보와 결제 정보는 시트에 저장하지 않습니다.
- 변경 기록은 시각, 작업 종류, 항목 ID, 버전을 보관합니다. 새로 저장한 항목의 동일 요청 재시도는 중복 행을 만들지 않습니다. 수정은 한 앱 배포의 스크립트 잠금 안에서 버전을 검사하며, 실제 항목과 이력은 Google Sheets 한 배치에서 저장합니다.
- API는 JSON 결과의 ok, status, error 값을 사용합니다. Apps Script ContentService에는 원하는 HTTP 상태 코드를 반환하는 일반 API가 없습니다. GET은 업무나 일정을 반환하지 않습니다.
- 로컬 검증은 Node.js에서 서명 검증과 시트 작업을 테스트합니다. 실제 Apps Script V8에서 BigInt를 포함한 서명 검증, GitHub Pages → Apps Script 응답 전달은 소유자가 웹앱을 배포한 뒤 확인해야 합니다.

공식 안내: [Google ID 토큰 검증](https://developers.google.com/identity/gsi/web/guides/verify-google-id-token), [바인딩된 스크립트](https://developers.google.com/apps-script/guides/bound), [Apps Script 고급 Google 서비스](https://developers.google.com/apps-script/guides/services/advanced), [Sheets batchUpdate](https://developers.google.com/workspace/sheets/api/reference/rest/v4/spreadsheets/batchUpdate).

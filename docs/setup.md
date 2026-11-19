# Google Sheets 연결 및 실제 검증

시트는 비공개로 두고, 재필님이 사용자를 정합니다. 아래 머리글은 1행에서 순서대로 작성합니다.

| 탭 | 열 |
| --- | --- |
| 업무 | id · title · category · owner · due · status · next · revision · updatedAt · updatedBy |
| 일정 | id · title · owner · date · time · revision · updatedAt · updatedBy |
| 허용 계정 | email |
| 변경 기록 | at · actor · entity · recordId · action · revision · requestHash |

- 시트에서 바인딩한 Apps Script 편집기의 `prepareAonSpreadsheet`를 한 번 실행하면 필요한 빈 탭과 머리글이 만들어지고 `AON_SHEET_ID`가 설정됩니다. `AON_GOOGLE_CLIENT_ID`는 스크립트 속성에 직접 입력합니다. OAuth **클라이언트 시크릿**은 이 흐름에서 사용하지 않습니다.
- Apps Script 고급 Google Sheets 서비스(v4)가 매니페스트에 선언되어 있습니다. 표준 Google Cloud 프로젝트를 연결한 경우 Google Sheets API를 직접 사용 설정합니다. 비공개 시트는 배포자 계정에만 필요한 권한을 부여합니다. 조직 정책상 Apps Script 배포가 막히는 경우 권한을 넓히기 전에 원인을 확인합니다.
- 웹앱은 배포자 권한으로 실행합니다. 공개 경로에 들어온 각 읽기·등록·수정 요청은 Google ID 토큰 및 허용 계정을 재검증합니다. 빈 허용 목록은 모든 사용자 요청을 거부합니다.
- GitHub Pages는 Google이 허용한 웹 원본에서 Google 로그인 버튼을 띄우고, 발급된 ID 토큰을 Apps Script의 요청 본문으로 보냅니다. 브라우저 저장소와 URL에는 토큰을 넣지 않습니다.
- 시트 직접 편집은 앱의 수정 버전과 변경 기록을 우회하므로 운영 행 편집은 앱에서 합니다. 허용 계정은 재필님이 시트에서 관리합니다.

## 실기기 검증 순서

1. 허용 계정 로그인 → 가상 업무 등록 → 앱 ‘새로고침’ 및 브라우저 재접속·로그인 → 같은 값 → 수정 → 시트 값, 버전, 수정 시각과 변경 기록 확인.
2. 미로그인 및 비허용 Google 계정 모두 업무·일정 조회와 저장이 거부되는지 확인.
3. 같은 업무를 두 탭에서 같은 버전으로 열어 각각 수정을 시도. 첫 저장만 반영되고 둘째 탭은 충돌 안내와 최신 불러오기를 제공해야 합니다.
4. 390px 모바일 화면에서 가로 넘침, 로그인, 두 메뉴와 폼, 저장 오류 안내 확인.
5. 재필님 승인 후에만 별도 전달된 `AON_오늘의센터_첫등록.json`의 5건을 등록. 기존 보드 ID 필드는 빼고 제목 5개를 다시 읽어 대조합니다. 파일과 실제 행은 GitHub에 올리지 않습니다.
6. 주소와 저장 위치가 실제 검증을 통과하면 [스킬 갱신안](aon-work-board-skill-update.md)을 적용할지 재필님에게 확인합니다. 이전 ChatGPT 사이트 종료는 재필님이 직접 결정합니다.

작성, 로컬 검증, 실계정 검증, 게시 승인을 별도로 보고합니다. Google OAuth 원본, 실제 Apps Script 웹앱 응답과 교차 출처 요청은 배포 승인 뒤 브라우저에서 확인해야 합니다.

# 영수증 스캐너

영수증 사진의 영역을 맞추고 그림자와 명암을 정리해 청구용 이미지로 저장하는 설치형 웹앱(PWA)입니다.

- 사용: https://playskil108-cmyk.github.io/receipt-scanner/
- 아이폰: Safari로 열고 공유 버튼 → "홈 화면에 추가"
- 안드로이드: Chrome으로 열고 ⋮ 메뉴 → "앱 설치"

사진은 기기 안에서만 처리되며 서버로 전송되지 않습니다. 한 번 연 뒤에는 인터넷 없이도 동작합니다.

## 파일
- `index.html`, `app.css`, `app.js` — 화면과 흐름 (촬영 → 영역 → 보정 → 저장)
- `core.js` — 원근 보정, 자동 영역 감지, 그림자 제거·명암 보정
- `sw.js`, `manifest.webmanifest`, `icons/` — 설치와 오프라인 지원

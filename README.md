# 다람쥐구조대 · 오목

길드 멤버들이 함께 즐기는 실시간 오목 웹사이트입니다.

## 기능

- 닉네임 입장 · 방 만들기/참가 · 관전
- 실시간 멀티플레이 (Socket.io)
- 채팅, 준비 시스템, 45초 턴 타이머
- 무르기 / 기권 / 무승부 제안 / 재대결
- AI 연습 모드 (쉬움 · 보통 · 어려움)

## 로컬 실행

```bash
npm install
npm start
```

브라우저에서 http://localhost:3000 접속

Windows에서는 `start.bat` 또는 `웹사이트 열기.bat` 더블클릭

## GitHub 업로드

```bash
cd C:\Projects\daramjwi-guild
git init
git add .
git commit -m "다람쥐구조대 오목 사이트"
git branch -M main
git remote add origin https://github.com/아이디/저장소이름.git
git push -u origin main
```

> `node_modules/`, `.node/`, `archive-old-guild/` 는 `.gitignore`에 등록되어 자동 제외됩니다.

## 클라우드 배포 (Render)

1. GitHub에 푸시
2. [Render](https://render.com) → New → Web Service
3. 저장소 연결
4. 설정:
   - **Build Command:** `npm install`
   - **Start Command:** `npm start`
5. 배포 후 제공되는 URL로 접속

`render.yaml`이 포함되어 있어 Render에서 자동 인식됩니다.

## 기술 스택

- Node.js + Express
- Socket.io
- Vanilla HTML / CSS / JavaScript

## 라이선스

MIT
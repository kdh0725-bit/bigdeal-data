# bigdeal-data

`제일 싼 쇼핑몰 찾아줄게`(bigdeal) 데이터 파이프라인.

```
batch/batch.mjs        모체 산출물 fetch → 정규화 → 앵커 병합 → 판정 재계산
batch/verify.mjs       배포 게이트 (14항목 · 실패 시 push 중단)
batch/verdict-sim.mjs  판정·이력 로직 전수 검사 (17항목)
data/anchors.json      수작업 증강 목록 (유일하게 손으로 편집하는 파일)
data/deals-latest.json 산출물 — 앱이 raw 로 fetch
.github/workflows/batch.yml   01:10 KST 자동 실행
```

## 규칙
- 모체(`deal-salkka-data`) 저장소·코드·스케줄러를 건드리지 않는다. 읽기만 한다.
- 모체가 낡았으면 배치가 exit(1) — Actions 실패가 곧 알림이다.
- 이력의 공식 의미: **"그날 구매 가능했던 최저가"** (n=당일 판매처 수 · s=최저 판매처)
- 낡은 확인가(checkedAt ≠ 당일)는 오늘 이력에 들어가지 않는다. 화면 표시만 한다.
- 사이트코드는 A100706845 하나뿐. 모체 코드(A100706842) 혼입은 배치·verify 이중 차단.

## 로컬 실행
```
node batch/verdict-sim.mjs
node batch/batch.mjs --allow-stale   # 로컬 테스트 전용
node batch/verify.mjs --allow-stale
```

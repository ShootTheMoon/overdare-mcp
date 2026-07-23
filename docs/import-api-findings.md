# OVERDARE 임포트 우회 경로 — 조사 결과

조사일: 2026-07-22 · 대상: Studio `36.3.0-release-36.3419.87aecc6` (UGC `37.0.0-release-36.7a95a2be7`)

GUI 클릭 임포트(`scripts/gui_import.ps1`)를 대체할 프로그래매틱 경로가 있는지 확인한 기록.
**구현은 하지 않음.** 결론과 근거, 그리고 각 경로의 go/no-go만 정리한다.

---

## 결론 요약

| 경로 | 결과 | 근거 |
|---|---|---|
| RPC(13377)에 업로드 추가 | **불가** | 업로드 메서드 자체가 없음. `asset_drawer.import`는 기존 id 배치 전용 |
| HTTP 백엔드 직접 호출 | **부분 가능하나 반쪽** | 업로드 물건이 raw FBX가 아니라 **쿡된 `.uasset`** 이라, 쿡을 우리가 못 만들면 의미 없음 |
| 커맨드릿으로 로컬 쿡 | **불가** | Shipping 빌드에 커맨드릿 클래스가 전부 스트립됨(`Cook`조차 없음) |
| **Remote Control(30010)로 스튜디오 내부 함수 호출** | **가장 유망 / 미검증** | `MAssetTools.ImportAssetTasks()` 와 `MAssetImportTask`가 살아있고 describe됨. 단 CDO 직접 호출은 **크래시** |

가장 큰 소득은 **"임포트를 시키는 진짜 API 표면이 이미 로컬에 열려 있다"** 는 확인이고,
가장 큰 미해결은 **그 함수를 안전하게 호출할 인스턴스를 어떻게 얻는가** 이다.

---

## 1. 임포트 파이프라인 실체

`UGCLocalAssetTable.json` 항목 1건(내가 오늘 올린 Factory) 기준:

```json
{ "contentId": "39685500", "name": "HQ_Factory_overdare",
  "packageName": "/Asset/TempImportedAssetDir/HQ_Factory_overdare",
  "assetFileUrl": "https://asset-prod.cdn.overdare.com/assets/world-asset/raw/live/39685500/0/build.zip",
  "worldAssetType": "STATIC_MESH" }
```

`assetFileUrl`은 **인증 없이 그냥 받아진다** (HTTP 200, 1.37 MB). 압축 내용:

```
39685500/39685500.uasset            1,440,981 B   ← 쿡된 UE 에셋 (로컬 캐시본과 바이트 동일)
CollectedLevelDependencyAssets.txt         26 B   → "/Asset/39685500/39685500"
metadata.json                             158 B   → studioVersion / studioUGCVersion
CommandletArgs.json                       566 B   → 쿡 인자 (아래)
```

`CommandletArgs.json` = 이 에셋을 만든 쿡 호출 그대로:

```
-cook -ResourcePakRootName=Asset -TargetResourcePath=/Asset/39685500
-ContentId=39685500 -UseAssetRegistry -UGCContent=true
-UploadResults=false -DisableFrameTraceCapture
```

→ **contentId를 먼저 발급받은 뒤** `/Asset/{id}` 로 쿡한다. 즉 순서는
`id 예약(HTTP) → 로컬 임포트+쿡 → zip → presigned URL 업로드`.

로컬 캐시: `%LOCALAPPDATA%\Sandbox\Saved\PersistentDownloadDir\Asset\{id}\{id}.uasset` (현재 391개)

## 2. 백엔드 REST 표면 (`Sandbox-Win64-Shipping.exe` 문자열 추출)

```
POST /backend/sandbox/user/world-asset/build/presigned-url        ← 본체 업로드
POST /backend/sandbox/user/world-asset/thumbnail/presigned-url
POST /backend/sandbox/user/world-assets/exist
GET  /backend/sandbox/user/world-asset/list | /recent | /recent/list
GET  /backend/sandbox/world-asset/file-url?worldAssetId=
POST /backend/sandbox/account/refresh
```
인증: `Authorization: Bearer` (바이너리에 두 문자열 모두 존재).

**하지만** 이 경로로 가려면 우리가 `.uasset`을 만들어내야 하는데, 그게 다음 항목에서 막힌다.

## 3. 커맨드릿 — 막힘 (확정)

```
Sandbox-Win64-Shipping.exe -run=UGCCommandlet         → "UGCCommandlet looked like a commandlet, but we could not find the class."
Sandbox-Win64-Shipping.exe -run=Cook                  → "CookCommandlet ... could not find the class."
Sandbox-Win64-Shipping.exe -run=UGCStreamingBuild     → 동일
Sandbox-Win64-Shipping.exe -run=MUGCStreamingWorldImporter → 동일
```

`-run=` 파싱 자체는 동작한다(엔진이 뜨고 pak을 마운트한 뒤 클래스를 찾는다).
즉 **기능이 아니라 클래스가 없는 것** — Shipping 빌드에서 컴파일 제외됨.
따라서 쿡은 **실행 중인 스튜디오 프로세스 안에서만** 가능하다.

## 4. Remote Control (30010) — 진짜 지렛대

`GET /remote/info` → 33개 라우트. 핵심: `PUT /remote/object/call`, `/property`, `/describe`, `/batch`.

살아있는 클래스 (describe 성공):

**`/Script/SandboxPlugin.Default__MAssetTools`** — 함수 목록에
```
ImportAssetTasks()
ImportAssetsWithDialog(FString DestinationPath, bool bAutomated)
CreateAsset(FString AssetName, FString PackagePath, UClass* AssetClass, UMFactory* Factory, FName CallingContext)
CreateUniqueAssetName(FString InBasePackageName, FString InSuffix)
...
```

**`/Script/SandboxPlugin.Default__MAssetImportTask`** — 프로퍼티
```
Filename, DestinationPath, DestinationName, bReplaceExisting, bAutomated,
bSave, bAsync, Factory(UMFactory*), Options(UObject*), ImportedObjectPaths, Result
함수: IsAsyncImportComplete(), GetObjects()
```

**`/Script/Sandbox.Default__MUGCImportDialogData`** — GUI 임포트 다이얼로그의 옵션이 전부 프로퍼티로 노출
```
Name, bImportOnlyAsModel, bHasCageMesh, bUseCageMesh, bInsertInWorkspace,
bInsertUsingScenePosition, bSetModelInstancePivotToSceneOrigin,
WorldForward(Front|Back|Left|Right), WorldUp(Top|Bottom|Left|Right),
ScaleUnit(Stud|Meter|CM|MM|Foot|Inch), bMergeMeshes, bInvertNegativeFaces, ...
```
> `bImportOnlyAsModel` 이 지금까지 화면 좌표로 찍어대던 "Import Only as Model" 체크박스다.

### 확인된 한계 — CDO 직접 호출은 크래시

```
PUT /remote/object/call
  objectPath = /Script/SandboxPlugin.Default__MAssetTools
  functionName = CreateUniqueAssetName        ← 부작용 없는 순수 함수
→ 스튜디오 즉사. EXCEPTION_ACCESS_VIOLATION reading 0x0
   (크래시 덤프: Saved\Crashes\UECC-Windows-D166CF8343FB8C689F12CB9878C577DA_0000)
```
`Default__` CDO는 유효한 `this`가 아니다(내부 싱글턴 포인터가 null). 다음 조사에서는
**실제 인스턴스 경로**를 찾아야 한다 (`/Engine/Transient.*` 아래 서브시스템 등).

## 5. RPC에 토큰 발급 메서드가 있다 — `hub.token.read`

크래시 로그(`Saved\Crashes\...\Sandbox.log`)에서 발견:

```
#### Processing command: [hub.token.read] ####
#### Preparing to send response: {"jsonrpc":"2.0","result":{"success":true,"token":"<JWT REDACTED>"},"id":1}
```

- 알려진 19개 메서드 목록에 **없던 메서드**다. `hub.*` 네임스페이스가 통째로 미탐색.
- 반환값은 백엔드용 베어러 JWT (payload에 id/namespace/email/provider/iat/exp, 수명 24h).
- → **HTTP 경로의 인증 문제는 이걸로 해결된다.** 프록시 스니핑도 토큰 파일 탐색도 불필요.
- 단, 인증이 풀려도 §1·§3의 **쿡 벽은 그대로**다.

**보안 주의:** 이 토큰이 `Sandbox.log`에 평문으로 남고, `CrashReportClient.ini`가
`bSendLogFile=True`다. 즉 **크래시 리포트를 전송하면 토큰이 함께 업로드된다.**
크래시 후에는 로그아웃/재로그인으로 토큰을 무효화하는 것이 안전하다.

다음 조사 항목: `hub.*` 메서드 열거 (`hub.token.read` 외에 무엇이 있는지).

## 6. 부수 발견 — 오늘의 장애 원인

`"Your studio is not up to date — reconnect via the Epic Store and update"` 모달이 **주기적으로 뜬다.**
이 모달이 메시지 펌프를 막는 동안 **13377과 30010이 연결은 되지만 응답하지 않는다.**
오늘 겪은 것들이 전부 여기서 설명된다:
- `world-assets/exist` 403
- 스튜디오가 코어 하나 100%로 15분 무응답
- GUI 임포터의 `NO_FILE_DIALOG` 연속 실패

**조치: Epic Store에서 스튜디오를 업데이트할 것.** 자동화 안정성의 전제 조건이다.

---

## 다음 조사 (구현 전 확인 필요)

1. `MAssetTools` **실제 인스턴스** 경로 찾기 — `/remote/search/assets` 나
   `/Engine/Transient.` 하위 탐색. CDO가 아닌 인스턴스에서만 호출 시도.
2. `ImportAssetTasks`의 실제 시그니처(배열 인자) 확인 — RC describe가 인자를 생략함.
3. UObject 생성 문제: RC로 `MAssetImportTask` 인스턴스를 만들 수 없다면
   `ImportAssetsWithDialog(DestinationPath, bAutomated=true)` 가 파일 다이얼로그를
   건너뛰는지 실측.
4. 안전장치: 호출 테스트는 **반드시 프로젝트 백업 후**. 오늘처럼 즉사할 수 있다.

## 남은 대안 (RC가 막힐 경우)

**Bulk Import** — 공식 기능, 파일 1개당 메시 200개까지 등록. GUI 상호작용을 200배 줄인다.
고폴리 에셋을 30k 미만 조각으로 쪼개는 전략과 궁합이 좋다. 실측 미완료:
등록된 MeshPart에 TextureId가 붙는지 확인 필요.

---

## 주의

- 여기 적힌 백엔드 엔드포인트는 비공개 API다. 직접 호출은 ToS 위반 소지가 있고 업데이트로 깨진다.
  **RC 경로는 앱이 스스로 노출한 API이므로 그런 문제에서 자유롭다** — 그래서 RC가 1순위다.
- 계정 토큰은 이 문서 어디에도 기록하지 않았다. 로그 캡처 단계로 갈 경우에도 `<REDACTED>` 처리할 것.

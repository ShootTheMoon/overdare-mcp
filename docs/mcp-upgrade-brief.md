# Claude Code 전달용 — OVERDARE MCP 고도화 브리프

아래 코드블록을 그대로 붙여넣으면 된다.
(원본 초안은 OVERDARE 내장 에이전트가 `onlyoneshot` 월드 폴더만 보고 작성해서
"MCP가 아직 없다"는 잘못된 전제로 시작했다. 이 문서는 그걸 교정한 버전이다.)

---

````text
OVERDARE Studio용 MCP 서버를 **이미 만들어 뒀고**, 그걸 고도화하고 싶다.
새로 만들지 마라. 기존 저장소를 읽고, 아래 우선순위대로 개선 계획을 세워라.
계획을 내가 승인하기 전에는 구현을 시작하지 마라.

## 0. 기존 저장소 (먼저 읽을 것)

경로: C:\Users\29\Desktop\overdare-mcp   (게임 월드는 C:\Users\29\Desktop\onlyoneshot, 별도)

현황: TypeScript + Node.js, @modelcontextprotocol/sdk, zod, stdio 전송. 빌드됨(`npm run build`).
MCP 툴 34개 등록됨.

핵심 파일:
- src/tools.ts        (약 1,500줄) 툴 34개 등록. 여기가 가장 크고 가장 손봐야 할 곳
- src/rpcClient.ts    Studio RPC 클라이언트 (TCP 13377, 개행 구분 JSON-RPC 2.0)
- src/ovdrjm.ts       .ovdrjm 프로젝트 파일 읽기/쓰기 (인코딩 스니핑 포함)
- src/remoteControl.ts UE Remote Control 클라이언트 (HTTP 30010)
- src/assets.ts, src/knowledge.ts, src/instanceTypes.ts
- src/probe.ts        RPC 수동 탐침 (npm run probe)
- scripts/            Blender 변환·GUI 자동화 20개 (아래 참조)
- docs/import-api-glossary.md 오늘 조사한 임포트 경로 분석

기존 툴 34개:
  status, set_project, browse, find, read_instance, create_instance, create_instances,
  create_part, update_instance, move_instance, duplicate_instance, delete_instance,
  instance_delete, apply, save, publish, play, stop, screenshot,
  script_add, script_edit, script_read, assets, asset_import, image_import,
  mesh_prepare, rpc, rc_call, rc_property, rc_describe, rc_batch,
  rc_list_actors, rc_search_assets, rc_python

## 1. 이미 확인된 사실 — 다시 조사하지 마라

원본 초안이 "조사하라"고 한 항목들은 실측으로 답이 나와 있다. 추측하지 말고 이걸 전제로 삼아라.

**Studio 통신 방식 (2개, 둘 다 로컬)**
1. TCP 127.0.0.1:13377 — 개행 구분 JSON-RPC 2.0. 인증 없음.
2. HTTP 127.0.0.1:30010 — UE Remote Control. 33개 라우트.
   `PUT /remote/object/call | /property | /describe | /batch`, `PUT /remote/search/assets`

**RPC 커맨드 전체 목록** (Studio 바이너리에서 추출한 실제 표. 이게 전부다):
```
asset_drawer.import              asset_manager.image.import
instance.create                  instance.delete
instance.part.add                instance.model.add        instance.folder.add
instance.sound.add               instance.tool.add         instance.remote_event.add
instance.text_label.add          instance.text_button.add  instance.image_label.add
instance.image_button.add        instance.frame.add        instance.scrolling_frame.add
instance.ui_grid_layout.add      instance.ui_list_layout.add
instance.linear_velocity.add     instance.angular_velocity.add
instance.vector_force.add        instance.vfx_preset.add
level.browse   level.apply   level.publish   level.save.file
game.play      game.stop     game.screenshot
script.add     script.delete
hub.token.read                   action_sequencer_service.apply_json
```
주의: `instance.upsert` / `instance.read` / `instance.move` / `script.read` / `script.edit` /
`script.grep` / `project.json` 은 **없다.** 기존 코드가 .ovdrjm을 직접 편집하는 이유가 이것이다.

**카메라는 RPC에 없다 — Remote Control로 간다.** 바이너리에서 RPC 메서드 문자열을 전수 추출한
결과 총 34개이며 카메라/뷰포트 계열은 하나도 없다. 그리고 `Workspace.Camera`의 CFrame을
.ovdrjm에서 고쳐도 **에디터 뷰포트는 움직이지 않는다** (파일에는 쓰이지만 `level.apply`가
뷰포트 카메라를 다시 읽지 않는다 — 실측 확인). 실제로 동작하는 유일한 경로:

```
PUT /remote/object/call
objectPath   /Script/UnrealEd.Default__MUnrealEditorSubsystem   ← 실제 클래스는 /Script/SandboxPlugin
functionName SetLevelViewportCameraInfo | GetLevelViewportCameraInfo
parameters   { CameraLocation: {X,Y,Z}, CameraRotation: {Pitch,Yaw,Roll} }
```

CDO 경로로 호출해도 라이브 뷰포트에 적용된다. **좌표계 주의**: 이 함수는 UE 네이티브
(Z-up)라서 `UE(x, y, z) = OVERDARE(X, Z, Y)`로 축을 바꿔야 한다. UE yaw는 +X에서 +Y로 잰다.
`overdare_camera` 툴이 이 변환과 look-at/포커스 계산을 감싸고 있다.

### 에디터 서브시스템 전체 지도 (RC로 열려 있는 것)

바이너리에서 `*Subsystem` 96개를 뽑아 전수 describe한 결과, `/Script/SandboxPlugin`의 17개가
응답한다. 전부 `/Script/UnrealEd.Default__<클래스>` CDO 경로로 호출하면 라이브 에디터에 먹는다.
쓸 만한 것:

| 서브시스템 | 함수 | 용도 |
|---|---|---|
| `MUnrealEditorSubsystem` | `Set/GetLevelViewportCameraInfo`, `GetEditorWorld` | 뷰포트 카메라, 월드 경로 |
| `MLevelEditorSubsystem` | `EditorSet/GetGameView`, `EditorInvalidateViewports`, `IsInPlayInEditor`, `PilotLevelActor`, `SaveCurrentLevel` | 뷰포트 렌더 모드·재그리기·플레이 상태 |
| `MEditorActorSubsystem` | `GetAllLevelActors`, `Get/SetSelectedLevelActors`, `SetActorSelectionState`, `SelectNothing/All`, `InvertSelection`, `DuplicateActor`, `DestroyActor` | 라이브 액터 열거·선택 |
| `MEditorAssetSubsystem` | `ListAssets`, `DoesAssetExist`, `FindAssetData`, `SaveAsset`, `Duplicate/Rename/DeleteAsset` | 엔진 자산 레지스트리 |
| `MLayersSubsystem` | 레이어 47종 | (OVERDARE UI에 노출 안 됨 — 미사용) |

**주의**: 0-인자 함수는 raw curl로 `"parameters":{}`를 보내면 `Unable to deserialize request`가
난다. MCP의 RC 클라이언트 경로로는 정상 동작한다.

라이브 액터 경로는 `/User/<프로젝트>.<프로젝트>:PersistentLevel.LuaMeshPart_N` 형태이고
**DataModel의 ActorGuid와 이름이 매칭되지 않는다** — 엔진 액터와 Luau 인스턴스를 잇는 값싼
방법은 아직 없다. 그래서 선택 툴은 UE 경로를 받는다.

**식별자**: 인스턴스는 `ActorGuid` (32자 hex). 세션이 바뀌어도 유지됨.

**저장 형식**: `<프로젝트>\<이름>.ovdrjm` = JSON 트리.
인코딩이 **UTF-16LE+BOM 또는 UTF-8 둘 다** 나온다 → 반드시 BOM 스니핑 (src/ovdrjm.ts에 구현됨).
동반 파일: `.umap`, `UGCLocalAssetTable.json`(에셋 레지스트리), `Play.log`(실행 로그).

**Studio/프로젝트 탐지**: 프로세스명 `Sandbox*`.
열린 프로젝트를 아는 **유일하게 신뢰 가능한 방법은 `game.screenshot`이 반환하는 경로**다
(`<프로젝트>\Screenshots\...`). GUID 매칭은 쓰지 마라 — 이유는 §2 참조.

**메시 임포트**: 우회로가 없다. 네 방향 모두 실측으로 막힌 것 확인:
- RPC — 메시 파일 임포트 커맨드 자체가 없음 (`asset_manager.image.import`는 이미지 전용)
- 커맨드릿 — Shipping 빌드에 클래스 전부 스트립. `-run=Cook` 조차 "could not find the class"
- HTTP 백엔드 — 업로드 대상이 이미 쿡된 `.uasset`. 서버는 FBX를 받지 않음
- Remote Control — `MAssetTools.ImportAssetTasks()`가 보이지만 CDO 호출 시 **Studio 즉사**
  (EXCEPTION_ACCESS_VIOLATION), 실제 인스턴스는 `/Engine/Transient` 아래에 없음
→ 결론: **신규 메시는 Studio 임포트 UI를 거치는 수밖에 없다.**

## 2. 오늘 실제로 터진 사고들 — 이게 개선 우선순위의 근거다

**(A) 다른 프로젝트에 조용히 써버림 — 가장 심각**
`NewWorld`와 `onlyoneshot`은 같은 프로젝트를 복제한 형제라 Workspace/Camera/Lighting GUID가 동일하다.
GUID 매칭 탐지가 알파벳순으로 먼저 걸린 `NewWorld`를 골라서, 약 1시간 동안 편집이 **엉뚱한 프로젝트에**
들어갔다. 그동안 화면에는 아무 변화가 없었고, 나는 그걸 "크기 데이터 손상"으로 오진했다.

**(B) 복구 수단 없음**
Studio가 크래시하면서 임포트가 날아갔다. 스냅샷이 없어서 손으로 백업/복원했다.

**(C) Studio가 조용히 죽어 있는 상태를 감지 못 함**
`"Your studio is not up to date"` 모달이 주기적으로 뜨는데, 이게 떠 있는 동안
**13377과 30010이 TCP 연결은 수락하면서 응답은 하지 않는다.** 포트 열림 확인은 무의미하다.
이것 때문에 15분 무응답, 403, GUI 임포터 연속 실패가 났다.

**(D) 임포트 처리량**
GUI 파일 다이얼로그로 에셋 1개당 30~60초. 오늘 40개 넘게 넣느라 하루가 갔다.

**(E) 로그에 토큰 평문 노출**
`hub.token.read` 응답의 JWT가 `Sandbox.log`에 그대로 남고, `CrashReportClient.ini`가
`bSendLogFile=True`다 → 크래시 리포트 전송 시 토큰이 함께 업로드된다.

## 3. 개선 우선순위

### P0 — 안전장치 (이것부터)

1. **프로젝트 타깃 확정**
   - `game.screenshot` 경로를 1순위 탐지로. GUID 매칭은 **유일하게 일치할 때만** 채택하고
     후보가 2개 이상이면 추측하지 말고 실패시켜라.
   - 모든 쓰기 툴은 대상 프로젝트 경로를 결과에 **에코**해서 사용자가 확인 가능하게.
   - 세션 시작 시 `overdare_set_project`로 고정하는 흐름을 문서화.

2. **스냅샷 / 롤백**
   - `overdare_snapshot_create | list | restore`
   - 파괴적 툴(delete, 대량 create, apply)은 자동으로 직전 스냅샷을 남길 것.
   - `.ovdrjm` 통째 복사면 충분하다 (현재 약 2.4MB).

3. **Studio 헬스 프리플라이트**
   - 포트 열림으로 판정하지 마라. **실제 RPC 왕복**(가벼운 메서드)으로 판정할 것.
   - `Process.Responding == false` 또는 RPC 무응답이면 명확한 오류
     (`STUDIO_BUSY_OR_MODAL`)로 즉시 실패. 재시도로 두들기지 마라 — 그게 Studio를 더 망가뜨렸다.
   - 가능하면 모달 감지도 (창 열거로 `#32770` 확인).

### P1 — 임포트 처리량

4. **Bulk Import 파이프라인**
   Bulk Import는 **파일 1개당 메시 200개**를 등록한다. GUI 상호작용을 200배 줄이는 유일한 방법이다.
   - Blender에서 메시들을 하나의 FBX 번들로 묶기 (각 메시는 별도 오브젝트, 이름이 곧 에셋명).
     `scripts/bundle.py`에 초안 있음.
   - Bulk Import 1회 → `UGCLocalAssetTable.json`에서 신규 contentId 역조회 → 배치.

   **실측 완료 (2026-07-22).** 메시 3개 번들로 검증했고 결과는 이렇다:
   ```
   39709100 STATIC_MESH  BulkTest2_HQ_Bench_overdare       ↔ 39707100 TEXTURE 00_HQ_Bench_T
   39709200 STATIC_MESH  BulkTest2_HQ_TrashBin_overdare    ↔ 39708200 TEXTURE 00_HQ_TrashBin_T
   39710100 STATIC_MESH  BulkTest2_HQ_BusShelter_overdare  ↔ 39708100 TEXTURE 00_HQ_BusShelter_T
   39710200 MODEL        BulkTest2
   ```
   - **텍스처는 함께 업로드된다.** MODEL 래퍼도 번들당 1개 생성된다.
   - 이름 규칙: 메시 `<번들파일명>_<오브젝트명>`, 텍스처 `00_<이미지데이터블록명>`.
     → 공통 키로 **자동 페어링 가능**.
   - `MeshId`+`TextureId`를 직접 지정해 MeshPart를 만들면 **정상적으로 텍스처가 렌더된다** (육안 확인).

   함정 두 개 (둘 다 대응 완료/필요):
   - **베이크 이미지 이름이 유니크해야 한다.** 전부 `BakedDiffuse`로 같으면 업로드 시
     `00_BakedDiffuse` / `_ncl1_1` / `_ncl1_2` 로 충돌해 어느 메시 것인지 알 수 없게 된다.
     → `scripts/prepare_mesh.py`에서 `<에셋명>_T`로 바꿔 해결함.
   - **Bulk Import는 다이얼로그가 다르다.** 단일 임포트의 `Import` 버튼이 아니라
     `Mesh Import Options` 창의 **`Apply All`** 을 눌러야 한다. 안 누르면 모달이 열린 채
     남아 `level.save.file`까지 타임아웃되고 등록도 되지 않는다.
     → `scripts/gui_import.ps1`의 `-Bulk` 경로에서 **해결함**. 좌표 하드코딩 대신
       창을 캡처해 액센트 블루(`B>150 && B-R>60 && B-G>40`)를 24px 격자로 클러스터링하고
       가장 오른쪽 덩어리(= Apply All)를 누른다. 창 크기·DPI가 바뀌어도 따라간다.
       못 찾으면 조용히 넘어가지 않고 `STATUS=NO_APPLY_BUTTON`으로 실패한다.
     - Bulk 다이얼로그는 "Import only as model"이 **기본 해제**다(단일 임포트와 반대).
       그래서 Bulk 경로에서는 체크박스를 건드리지 않는다.

   **파이프라인 구현 완료 (실측 통과).**
   - `scripts/bundle_meshes.py` — 준비된 FBX 여러 개를 메시 오브젝트 하나씩으로 묶어 번들 생성.
     에셋별 `meshObject` / `images`를 리포트해서 나중에 이름으로 짝을 맞출 수 있게 한다.
     같은 basename이 두 번 오면 에셋명이 충돌하므로 `duplicateNames`로 먼저 거른다.
   - `overdare_mesh_bulk_import` 툴 (src/tools.ts) — 번들 → Bulk Import 1회 → 등록 대기 →
     이름으로 mesh/texture 페어링 → `[{asset, meshId, textureId}]` 반환.
   - 3개 번들 실측 결과:
     ```
     HQ_TrashBin_overdare     mesh 39732100 | tex 39730200
     HQ_Bench_overdare        mesh 39732200 | tex 39730100
     HQ_BusShelter_overdare   mesh 39730300 | tex 39731100
     ```
     **id 순서가 섞여 있다** (BusShelter 메시가 TrashBin 텍스처보다 뒤). 즉 id 순서로
     짝을 맞추면 틀린다 — 이름 기반 페어링이 필수라는 게 실측으로 확인됐다.

5. **GUI 자동화 강건화** (없앨 수 없으니 견고하게)
   - 임포트 전 Studio 준비 상태 확인 (위 3번 재사용).
   - 포커스 탈취 감지 (오늘 카카오톡 팝업이 배치 하나를 통째로 날림).
   - 실패를 조용히 삼키지 말 것 — 오늘 `STATUS=IMPORTED`인데 실제로는 0건인 경우가 있었다.

### P2 — 구조 정리 (원본 초안에서 가져올 만한 것들)

6. **구조화된 결과 봉투와 오류 코드** — 원본 초안의 이 부분은 좋다. 그대로 채택.
   `{success, data, warnings, meta}` / `{success:false, error:{code,message,details,retryable}}`
   코드 예시: `STUDIO_NOT_CONNECTED`, `STUDIO_BUSY_OR_MODAL`, `PROJECT_AMBIGUOUS`,
   `INSTANCE_NOT_FOUND`, `UNSUPPORTED_CLASS`, `REQUEST_TIMEOUT`, `INTERNAL_ERROR`

7. **src/tools.ts 분해** — 1,500줄 단일 파일이다. 도메인별로 쪼개라
   (project / level / instance / script / play / asset / rc).

8. **MockStudioTransport + 테스트** — Studio 없이 도는 통합 테스트. Vitest.

9. **로그 위생** — 토큰/Authorization/개인 경로 마스킹. §2(E) 참조.

## 4. 원본 초안에서 **반드시 뒤집어야 할** 두 가지

원본 초안은 아래 둘을 "구현하지 않는다"로 분류했는데, 이 프로젝트에서는 **둘 다 필수다.**

- **"임의 프로젝트 파일 직접 수정 제외"** →
  RPC에 `instance.upsert`가 **없다.** `.ovdrjm` 직접 편집이 기존 MCP 기능 대부분의 토대다.
  제외하면 서버가 껍데기가 된다. 대신 *안전하게* 하라: 스냅샷 + 경로 제한 + 스키마 검증.

- **"Studio UI 자동화 제외"** →
  메시 임포트의 **유일한** 경로다 (§1 참조, 네 방향 모두 실측으로 막힘).
  제외하면 블렌더 모델을 넣을 방법이 사라진다. 대신 강건하게 만들어라 (P1-5).

## 5. 첫 답변 형식

코드 말고 아래로 답해라.
1. 기존 저장소 읽고 파악한 현황 (툴 34개 중 무엇이 견고하고 무엇이 취약한지)
2. P0 세 항목 각각의 구현 방안
3. Bulk Import 파이프라인 설계
4. src/tools.ts 분해 계획
5. 테스트 전략 (MockStudioTransport 포함)
6. 단계별 순서와 각 단계 완료 조건
7. 위험 요소

막히는 결정이 있으면 최대 5개까지만 질문해라.
확인되지 않은 OVERDARE API를 지어내지 마라 — §1에 없는 커맨드는 존재하지 않는다고 가정하라.
````

---

## 원본 초안 대비 바뀐 점 요약

| 원본 | 교정 |
|---|---|
| "MCP 없음, 새로 만들기" | 34개 툴 기존 저장소 고도화 |
| 통신 방식 조사 요청 | 실측 결과 제공 (RPC 커맨드 전체 표 포함) |
| 파일 직접 수정 제외 | **필수** — `instance.upsert`가 없음 |
| UI 자동화 제외 | **필수** — 메시 임포트 유일 경로 |
| 우선순위 없음 | 오늘 실제 사고 5건 기준 P0/P1/P2 |

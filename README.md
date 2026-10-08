# VibeContext

AI 코딩 도구(Claude Code, Claude Desktop, Cursor 등)가 **프로젝트 전체를 읽지 않고도** 과거 결정과 현재 변경 사항을 알 수 있게 해 주는 **로컬 Context Layer**입니다.

- 아키텍처 결정과 과거 작업 내용을 SQLite에 남겨서 AI가 잊지 않게 합니다.
- Git 변경 사항을 raw diff 대신 구조화된 요약으로 제공해서 토큰 사용량을 줄입니다.
- 모든 데이터는 내 컴퓨터에만 저장됩니다. 소스코드를 외부 서버로 보내지 않습니다 (Local-first).

> 현재 상태: **Phase 1 (MCP Server)** 완료.
> Phase 2(Context Engine, `get_relevant_context`), Phase 3(Nuxt 4 Web Dashboard)는 아직 구현되지 않았습니다.

---

## 1. 아키텍처

```text
 AI Coding Tools (Claude Code / Claude Desktop / Cursor)
        │  MCP (stdio, JSON-RPC)
        ▼
┌─────────────────────── apps/server (로컬 프로세스) ───────────────────────┐
│  mcp/        MCP 서버 + Tool 등록 (입출력 스키마, Markdown 응답)           │
│    │                                                                     │
│    ├── project/  프로젝트 등록·조회, projectId 해석                        │
│    ├── git/      simple-git으로 변경 분석 → 구조화된 GitDelta              │
│    ├── memory/   세션·결정·규칙 저장 + 검색 (MemorySearcher 인터페이스)     │
│    └── (Phase 2) context/  Task → 관련 Memory/Git/Files → Context 최적화   │
│                                                                          │
│  db/         Drizzle ORM 스키마, SQLite 연결, 마이그레이션 자동 적용        │
│  utils/      설정(경로/환경변수), 로거(stderr), 에러, 토큰 추정기            │
└───────────────────────────────┬──────────────────────────────────────────┘
                                ▼
                     data/vibe-context.db (SQLite)
```

### 모듈별 역할

| 모듈 | 역할 | 의존 |
| --- | --- | --- |
| `src/index.ts` | 진입점. 설정 로드 → DB 열기/마이그레이션 → 서비스 생성 → MCP 서버를 stdio에 연결 | 전부 |
| `src/mcp/` | MCP 프로토콜 계층. Tool의 이름·설명·zod 입출력 스키마, 결과를 Markdown + `structuredContent`로 변환. 비즈니스 로직 없음 | project, git, memory |
| `src/project/` | 로컬 프로젝트 디렉토리 등록, id(slug) 생성, `projectId` 생략 시 현재 작업 디렉토리로 프로젝트 찾기 | db |
| `src/git/` | `git-analyzer.ts`: 마지막 커밋 이후 변경(스테이지/언스테이지/미추적)을 분석. DB를 모르는 순수 모듈. `git-snapshots.ts`: 분석 결과를 DB에 기록 | simple-git, utils |
| `src/memory/` | `memory-store.ts`: 세션 요약 저장/조회. `memory-search.ts`: `MemorySearcher` 인터페이스와 V1 키워드 검색 구현 | db |
| `src/db/` | Drizzle 스키마(`schema.ts`), 연결 + 마이그레이션(`client.ts`) | better-sqlite3 |
| `src/utils/` | `config.ts`(경로/환경변수), `logger.ts`, `errors.ts`, `tokens.ts`(`TokenEstimator` 인터페이스) | - |
| `packages/shared` | 서버와 (향후) 웹이 공유하는 **타입 전용** 패키지. `import type`으로만 사용하므로 빌드가 필요 없음 | - |
| `packages/config` | 공통 `tsconfig.base.json` (strict) | - |

### 확장 포인트 (Phase 4 대비)

과도한 추상화는 피하고, **나중에 교체될 것이 확실한 두 곳**에만 인터페이스를 두었습니다.

- `MemorySearcher` (`memory/memory-search.ts`): 지금은 `KeywordMemorySearcher`. 나중에 FTS5/embedding 검색기를 같은 인터페이스로 구현하면 MCP Tool은 바뀌지 않습니다.
- `TokenEstimator` (`utils/tokens.ts`): 지금은 문자 기반 추정(영문·코드 약 4자/토큰, 한글 약 1.5자/토큰). 모델별 tokenizer로 교체 가능.

### Tool과 Resource의 차이 (그리고 Phase 1에서 Resource를 만들지 않은 이유)

- **Tool**: 모델이 *스스로 판단해서 호출*하는 함수. 입력을 받아 계산한 결과를 돌려줍니다. (`get_git_delta`, `search_past_memory` 등)
- **Resource**: 클라이언트(사용자/앱)가 *선택해서 컨텍스트에 첨부*하는 읽기 전용 데이터. URI로 식별됩니다. (`project://{id}/architecture` 등)

Phase 1의 기능은 모두 입력(쿼리, 세션 내용)이 필요하거나 실행 시점의 상태(git)를 계산해야 해서 Tool이 맞습니다. Resource는 클라이언트마다 지원 방식이 다르고(Claude Code는 `@` 멘션, Claude Desktop은 첨부 메뉴), "항상 첨부할 고정 컨텍스트"인 **Architecture Rules / 최근 Memory**가 충분히 쌓이는 Phase 2에서 `project://{projectId}/architecture`, `project://{projectId}/memory`부터 추가하는 것을 제안합니다.

### 원래 제안 구조에서 바꾼 점

- `apps/server/drizzle/`: drizzle-kit이 생성한 SQL 마이그레이션 폴더. 서버 시작 시 자동 적용됩니다.
- `apps/server/scripts/smoke-test.mjs`: 실제 MCP 클라이언트처럼 서버를 띄워 모든 Tool을 호출하는 검증 스크립트.
- `src/context/`와 `apps/web/`은 Phase 2, 3에서 만듭니다. (빈 폴더를 미리 두지 않았습니다.)
- Tool 2개 추가: `register_project`, `list_projects`. 다른 Tool이 모두 등록된 프로젝트를 필요로 하므로, 대시보드가 생기기 전까지는 AI 클라이언트 안에서 등록할 수 있어야 합니다.

---

## 2. 디렉토리 구조

```text
vibe-context/
├── apps/
│   └── server/
│       ├── drizzle/                     # SQL 마이그레이션 (drizzle-kit generate 결과)
│       │   ├── 0000_init.sql
│       │   └── meta/
│       ├── scripts/
│       │   └── smoke-test.mjs           # E2E 검증 스크립트
│       ├── src/
│       │   ├── index.ts                 # 진입점 (stdio MCP 서버)
│       │   ├── mcp/
│       │   │   ├── server.ts            # McpServer 생성 + Tool 등록
│       │   │   ├── context.ts           # Tool에 주입되는 서비스 타입
│       │   │   ├── schemas.ts           # 공통 zod 스키마
│       │   │   ├── tool-result.ts       # 성공/에러 응답 헬퍼
│       │   │   └── tools/
│       │   │       ├── project-tools.ts         # register_project, list_projects
│       │   │       ├── git-delta-tool.ts        # get_git_delta
│       │   │       ├── session-summary-tool.ts  # save_session_summary
│       │   │       └── search-memory-tool.ts    # search_past_memory
│       │   ├── git/
│       │   │   ├── git-analyzer.ts
│       │   │   └── git-snapshots.ts
│       │   ├── memory/
│       │   │   ├── memory-store.ts
│       │   │   └── memory-search.ts
│       │   ├── project/
│       │   │   └── project-service.ts
│       │   ├── db/
│       │   │   ├── schema.ts
│       │   │   └── client.ts
│       │   └── utils/
│       │       ├── config.ts
│       │       ├── errors.ts
│       │       ├── logger.ts
│       │       └── tokens.ts
│       ├── drizzle.config.ts
│       ├── package.json
│       └── tsconfig.json
├── packages/
│   ├── shared/                          # 공유 타입 (타입 전용)
│   │   ├── src/index.ts
│   │   ├── package.json
│   │   └── tsconfig.json
│   └── config/
│       ├── tsconfig.base.json
│       └── package.json
├── data/                                # SQLite 파일 위치 (git에 올리지 않음)
│   └── .gitkeep
├── .gitignore
├── package.json
├── pnpm-workspace.yaml
└── README.md
```

---

## 3. 요구 사항

- **Node.js 22 이상** (`node -v`)
- **pnpm 10** (`corepack enable` 후 `pnpm -v`, 또는 `npm i -g pnpm`)
- **git** (PATH에 있어야 함)
- `better-sqlite3`는 네이티브 모듈입니다. 대부분의 OS/Node 버전은 미리 빌드된 바이너리를 내려받지만, 없으면 소스 빌드를 합니다.
  - macOS: `xcode-select --install`
  - Windows: Visual Studio Build Tools의 "C++를 사용한 데스크톱 개발"

---

## 4. 설치 및 실행

```bash
cd vibe-context
pnpm install          # 의존성 설치 (better-sqlite3 네이티브 빌드 포함)
pnpm build            # apps/server/dist 생성
pnpm smoke:server     # 임시 git 저장소 + 임시 DB로 모든 Tool을 실제 호출해 검증
```

`Smoke test passed`가 나오면 준비 완료입니다. 실제 데이터(`data/vibe-context.db`)는 건드리지 않습니다.

그 밖의 명령어:

| 명령어 | 설명 |
| --- | --- |
| `pnpm start:server` | 빌드된 서버를 stdio로 실행 (보통은 AI 클라이언트가 직접 실행하므로 수동 실행할 일은 없음) |
| `pnpm dev:server` | `tsx watch`로 소스 직접 실행 (개발용) |
| `pnpm inspect:server` | [MCP Inspector](https://github.com/modelcontextprotocol/inspector)로 브라우저에서 Tool을 직접 호출해 보기 |
| `pnpm typecheck` | 전체 타입 체크 |
| `pnpm db:generate` | `schema.ts` 변경 후 새 마이그레이션 SQL 생성 |
| `pnpm db:migrate` | 마이그레이션만 적용하고 종료 (서버 시작 시에도 자동 적용됨) |
| `pnpm db:studio` | Drizzle Studio로 DB 내용 보기 |

> stdio MCP 서버는 stdout을 프로토콜 통신에 사용합니다. 그래서 모든 로그는 stderr로 출력됩니다. 코드에서 `console.log`를 쓰면 클라이언트 연결이 깨지니 `logger`를 사용하세요.

### 환경변수 (모두 선택)

| 변수 | 기본값 | 설명 |
| --- | --- | --- |
| `VIBE_CONTEXT_DATA_DIR` | `<repo>/data` | 데이터 폴더 |
| `VIBE_CONTEXT_DB_PATH` | `<DATA_DIR>/vibe-context.db` | SQLite 파일 경로 (지정 시 DATA_DIR보다 우선) |
| `VIBE_CONTEXT_MIGRATIONS_DIR` | `apps/server/drizzle` | 마이그레이션 폴더 |
| `VIBE_CONTEXT_LOG_LEVEL` | `info` | `debug` / `info` / `warn` / `error` |

경로 기본값은 현재 작업 디렉토리가 아니라 **서버 파일 위치** 기준으로 계산합니다. 어떤 클라이언트가 어디서 서버를 실행해도 같은 DB를 사용합니다.

---

## 5. Claude Desktop 연결

1. `pnpm build`를 먼저 실행합니다.
2. 설정 파일을 엽니다. (Claude Desktop → Settings → Developer → Edit Config 로도 열 수 있습니다.)

| OS | 설정 파일 위치 |
| --- | --- |
| macOS | `~/Library/Application Support/Claude/claude_desktop_config.json` |
| Windows | `%APPDATA%\Claude\claude_desktop_config.json` |

3. `mcpServers`에 추가합니다.

**macOS**

```json
{
  "mcpServers": {
    "vibe-context": {
      "command": "node",
      "args": ["/ABSOLUTE/PATH/TO/vibe-context/apps/server/dist/index.js"]
    }
  }
}
```

**Windows** (JSON에서는 `\`를 `\\`로 씁니다)

```json
{
  "mcpServers": {
    "vibe-context": {
      "command": "node",
      "args": ["C:\\Users\\me\\dev\\vibe-context\\apps\\server\\dist\\index.js"]
    }
  }
}
```

4. Claude Desktop을 **완전히 종료 후 재시작**합니다. (macOS는 Cmd+Q, Windows는 트레이 아이콘에서 종료)
5. 대화창의 도구(🔨) 메뉴에 `vibe-context` Tool들이 보이면 성공입니다.

**잘 안 될 때**

- `nvm`/`fnm`/`volta`로 Node를 설치했다면 Claude Desktop이 `node`를 못 찾을 수 있습니다. `"command"`에 절대 경로를 쓰세요. (macOS: `which node`, Windows: `where node`)
- `NODE_MODULE_VERSION` 오류: `pnpm install`할 때와 다른 Node 버전으로 실행된 것입니다. `command`를 설치할 때 쓴 node 경로로 맞추거나 `pnpm rebuild better-sqlite3`.
- 로그: macOS `~/Library/Logs/Claude/mcp-server-vibe-context.log`, Windows `%APPDATA%\Claude\logs\`.
- DB 위치를 바꾸려면 `"env": { "VIBE_CONTEXT_DB_PATH": "/ABSOLUTE/PATH/my.db" }`를 추가합니다.

Claude Desktop에서는 서버의 작업 디렉토리가 프로젝트 폴더가 아니므로, Tool을 쓸 때 `projectId`를 알려 주세요. 예: "my-recipe-app 프로젝트의 git 변경 사항 알려줘"

---

## 6. Claude Code 연결

VibeContext는 표준 stdio MCP 서버라서 Claude Code에서도 그대로 동작합니다.

```bash
# 모든 프로젝트에서 사용 (사용자 범위)
claude mcp add --scope user vibe-context -- node /ABSOLUTE/PATH/TO/vibe-context/apps/server/dist/index.js

# 확인
claude mcp list
```

특정 저장소에서만 쓰고 팀과 공유하려면 저장소 루트에 `.mcp.json`을 둡니다.

```json
{
  "mcpServers": {
    "vibe-context": {
      "command": "node",
      "args": ["/ABSOLUTE/PATH/TO/vibe-context/apps/server/dist/index.js"]
    }
  }
}
```

Claude Code는 보통 프로젝트 폴더에서 MCP 서버를 실행합니다. 그래서 `projectId`를 생략하면 **현재 작업 디렉토리를 포함하는 등록된 프로젝트**를 자동으로 사용합니다. 찾지 못하면 등록된 프로젝트 목록과 함께 에러를 돌려주므로, 그때는 `projectId`를 지정하면 됩니다.

### Cursor

`~/.cursor/mcp.json` (전역) 또는 프로젝트의 `.cursor/mcp.json`에 Claude Desktop과 같은 `mcpServers` 형식으로 추가합니다.

---

## 7. 사용 흐름

```text
1. "이 프로젝트를 VibeContext에 등록해줘: /Users/me/dev/my-recipe-app"
     → register_project

2. 작업 시작: "레시피 삭제 기능 수정하려고 해. 먼저 변경 사항이랑 관련 기록 확인해줘"
     → get_git_delta, search_past_memory("recipe delete")

3. 작업 끝: "오늘 작업 내용 저장해줘"
     → save_session_summary
```

AI가 이 흐름을 자연스럽게 따르게 하려면 프로젝트의 `CLAUDE.md`(또는 Cursor rules)에 다음을 넣어 두면 좋습니다.

```md
## VibeContext
- 작업을 시작할 때 vibe-context의 get_git_delta와 search_past_memory를 먼저 호출한다.
- 작업을 마치면 save_session_summary로 결정사항과 아키텍처 규칙을 저장한다.
```

---

## 8. MCP Tools

모든 Tool은 사람이 읽기 좋은 Markdown(`content`)과 `outputSchema`에 맞는 JSON(`structuredContent`)을 함께 반환합니다. 예상 가능한 실패(프로젝트 없음, git 저장소 아님 등)는 `isError: true`와 `[ERROR_CODE] 메시지`로 반환합니다.

### `register_project`

| 입력 | 타입 | 설명 |
| --- | --- | --- |
| `name` | string | 프로젝트 이름 |
| `rootPath` | string | 프로젝트 루트 **절대 경로** (존재하는 디렉토리) |
| `id` | string? | 생략 시 이름의 slug (`My Recipe App` → `my-recipe-app`) |

출력: `{ project: { id, name, rootPath, createdAt, updatedAt } }`

### `list_projects`

입력 없음. 출력: `{ projects: Project[] }`

### `get_git_delta`

마지막 커밋 이후 변경(스테이지 + 언스테이지 + 미추적 파일)을 구조화해서 반환합니다. raw diff는 반환하지 않습니다.

| 입력 | 타입 | 설명 |
| --- | --- | --- |
| `projectId` | string? | 생략 시 작업 디렉토리로 추론 |
| `findDependents` | boolean? | 변경 파일을 참조하는 파일 검색 (기본 true) |

출력 (요약):

```ts
{
  projectId, branch, lastCommit: { hash, message, author, date } | null, isClean,
  files: { added, modified, deleted, renamed },   // 각 항목: path, previousPath?, linesAdded, linesDeleted, staged, binary
  stats: { filesChanged, linesAdded, linesDeleted, estimatedTokens },
  summary: string,
  potentiallyAffected: { areas: string[], dependents: string[] }
}
```

- `estimatedTokens`: 전체 diff + 새 파일 내용을 그대로 읽었을 때의 예상 토큰 수. 요약 대신 전부 읽었다면 얼마나 들었을지 보여 줍니다.
- `areas`: 변경이 몰린 디렉토리 (상위 2단계).
- `dependents`: 변경/삭제/이름변경된 파일의 경로(예: `stores/recipe`)를 텍스트로 포함하는 다른 tracked 파일. **import 그래프가 아닌 휴리스틱**이라 Nuxt auto-import처럼 경로가 코드에 없는 경우는 찾지 못합니다. (Phase 2+ dependency graph에서 개선)
- 모노레포 하위 폴더를 프로젝트로 등록하면 그 폴더의 변경만 봅니다.
- 호출할 때마다 결과가 `git_snapshots` 테이블에 기록됩니다 (대시보드용).

### `save_session_summary`

| 입력 | 타입 | 설명 |
| --- | --- | --- |
| `projectId` | string? | |
| `sessionTitle` | string | 작업 제목 |
| `summary` | string | 무엇을 했는지 1~5문장 |
| `decisions` | string[] | 결정사항 (가능하면 이유 포함) |
| `architectureRules` | string[] | 앞으로 지켜야 할 규칙. **프로젝트 내 중복은 저장하지 않음** |
| `changedFiles` | string[] | 변경 파일 |
| `problems` | string[] | 겪은 문제 |
| `solutions` | string[] | 해결 방법 |

배열은 모두 선택(기본 `[]`)이며, 앞뒤 공백 제거 / 빈 값 / 중복이 정리된 뒤 한 트랜잭션으로 저장됩니다.

출력: `{ sessionId, projectId, sessionTitle, createdAt, savedCounts: { decisions, problems, solutions, architectureRules } }`

### `search_past_memory`

| 입력 | 타입 | 설명 |
| --- | --- | --- |
| `projectId` | string? | |
| `query` | string | 키워드 (예: `recipe delete`) |
| `limit` | number? | 1~50, 기본 5 |

출력: `{ projectId, query, strategy: "keyword", hits: [{ sessionId, sessionTitle, summary, createdAt, score, matchedTerms, decisions, architectureRules, problems, solutions, changedFiles }] }`

V1 점수 계산 (`memory/memory-search.ts`):

- 질의를 단어로 나누고 가벼운 정규화를 합니다. 영어는 접미사 제거(`delete`/`deletion`/`deleted` → `delet`), 한국어는 끝 조사 제거(`레시피를` → `레시피`).
- 단어마다 가장 가중치가 높은 필드를 찾습니다: 제목 3, 결정/규칙 2, 요약 1.5, 문제/해결 1.2, 파일 1.
- `score = (가중치 합 / 최대치) × 0.7 + (일치한 단어 비율) × 0.3`, 여기에 최근일수록 조금 높게(0.9~1.0, 반감기 90일) 곱합니다. 결과는 0~1입니다.
- 한계: 의미 검색이 아니므로 한국어 질의로 영어 메모리를 찾지 못합니다. 메모리를 쓴 언어로 검색하세요. (FTS5 / embedding으로 교체 예정)

---

## 9. 데이터베이스

`apps/server/src/db/schema.ts` (Drizzle ORM, SQLite)

| 테이블 | 내용 |
| --- | --- |
| `projects` | id(slug), name, root_path(unique), created_at, updated_at |
| `sessions` | 세션 요약: project_id, title, summary, changed_files(JSON), created_at |
| `memories` | 세션에서 나온 개별 항목: kind(`decision`/`problem`/`solution`), content |
| `architecture_rules` | 프로젝트 규칙: rule, is_active, 처음 도입한 session_id. (project_id, rule) unique |
| `git_snapshots` | `get_git_delta` 결과 기록: 통계 + 전체 delta(JSON) |

- 시각은 Unix ms 정수로 저장하고 Drizzle에서 `Date`로 다룹니다.
- WAL 모드를 켜서 MCP 서버와 (향후) 대시보드가 동시에 DB를 써도 안전하게 했습니다.
- 프로젝트를 지우면 관련 데이터가 함께 삭제됩니다 (`ON DELETE CASCADE`).
- Phase 2에서 `files`, `file_dependencies`, `context_requests` 테이블을 추가할 예정입니다.

스키마 변경 절차:

```bash
# 1. apps/server/src/db/schema.ts 수정
pnpm db:generate     # 2. apps/server/drizzle/에 새 SQL 생성
pnpm build           # 3. 서버 재시작 시 자동 적용 (또는 pnpm db:migrate)
```

---

## 10. 로드맵

- [x] **Phase 1** MCP Server: SQLite + Drizzle, simple-git, `get_git_delta`, `save_session_summary`, `search_past_memory`
- [ ] **Phase 2** Context Engine: `get_relevant_context` (Task → 관련 Memory → Git → Files → MUST_READ / MAY_READ / IGNORE + 토큰 예산), 파일 인덱스/의존성 테이블, Resources
- [ ] **Phase 3** Web Dashboard (Nuxt 4): Projects / Memory / Git Changes / Context Analytics
- [ ] **Phase 4** FTS5, embedding 검색, dependency graph, context compression, 모델별 token 추정 등

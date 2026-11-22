# Аудит совместимости DeepSeek Harness с Telegram Serverless

- **Дата:** 2026-11-22
- **Ветка:** `telegram-serverless-adaptation`
- **База аудита:** `master` форка, синхронизированный с upstream на момент начала работ
- **Статус:** первичный аудит исходников; runtime-проверка на Telegram Serverless ещё не проводилась

## 1. Вывод

Полностью запустить стандартную Node.js-сборку DSH в Telegram Serverless нельзя. Но базовые части агентной архитектуры выглядят переносимыми: Cordis core, Session event model, Tool Registry и provider-neutral LLM API не требуют локального сервера по своей концепции.

Для работающего Serverless runtime потребуются четыре адаптации:

1. убрать ambient async context из `dsh-agent` либо заменить его явным контекстом инициатора;
2. отделить Agent Loop от Node.js UUID API;
3. подключить LLM через Telegram SDK `sdk/fetch`, не через обычный Node/global transport;
4. реализовать собственный `SessionPersistence` поверх Telegram SQLite SDK.

Плагинный код должен быть включён в deployable JavaScript заранее. Установка npm-пакетов и исполнение произвольного пользовательского JavaScript в runtime не поддерживаются.

## 2. Ограничения Telegram Serverless

По официальной документации Telegram:

- каждый invocation выполняется в изолированном V8 runtime;
- в runtime доступны SDK платформы и собственные модули проекта;
- нет `node_modules`, произвольных npm-пакетов и Node.js filesystem;
- сетевые запросы выполняются через `sdk/fetch`;
- SQLite доступна через `sdk/db`, все операции асинхронные;
- модули проекта импортируются относительными путями с расширением `.js`;
- deployable backend-модули находятся внутри `tgcloud/`;
- у SQLite выключены foreign keys;
- runtime не предоставляет Node `Buffer`; для байтов используется `Uint8Array`.

Официальный источник: https://blogfork.telegram.org/bots/serverless

### Следствие для сборки

DSH workspace не может быть загружен как набор npm-пакетов. Нужен build step вне Telegram Serverless, который собирает выбранное подмножество DSH в deployable JavaScript-модули внутри `tgcloud/`. Из внешних bare imports должны остаться только официальные модули SDK, например `sdk`, `sdk/db` и `sdk/fetch`.

Это не означает, что надо собирать весь DSH. CLI, Web Host, Desktop, npm plugin manager и локальные инструменты в первый Serverless runtime не входят.

## 3. Результаты аудита пакетов

### 3.1 Кандидаты на повторное использование

| Пакет | Результат первичного осмотра | Решение |
|---|---|---|
| `vendor/cordis` | Проверенные файлы Cordis core не импортируют Node built-ins. Core строится вокруг Context, Fiber, services и events. Требуется проверить транзитивный `@deepseek-ai/cosmokit`. | Оставить; собрать в bundle |
| `@deepseek-ai/dsh-session` | Исходники Session event model не импортируют Node built-ins. Session — in-memory append-only event log; persistence отделён отдельным сервисом. | Оставить |
| `@deepseek-ai/dsh-tools` | Проверенные исходники Tool Registry, schema и execution pipeline не импортируют Node built-ins. Исполнение определяется callback `ToolDefinition.execute`. | Оставить; внешние tools реализовать через SDK fetch |
| `@deepseek-ai/dsh-session-persistence` | Общий persistence contract не зависит от файлового backend. Предоставляет сервис `SessionPersistence` и per-session `SessionHandle`. | Оставить как контракт |
| `@deepseek-ai/dsh-llm` | Provider-neutral API содержит абстрактный `LlmAdapter`; обязательная точка адаптера — `stream(options)`. | Оставить |
| `@deepseek-ai/dsh-util-crypto` | Уже содержит browser-safe UUID через `crypto.getRandomValues` и base64 для `Uint8Array`. | Использовать вместо Node crypto после проверки Web Crypto в Serverless |

### 3.2 Подтверждённые несовместимости

#### `@deepseek-ai/dsh-agent`

Файл: `packages/core/agent/src/index.ts`

Прямые Node imports:

- `node:async_hooks` — `AsyncLocalStorage`;
- `node:util/types` — `isPromise`.

`AsyncLocalStorage` используется для `withInitiator()`, `withoutInitiator()`, `currentInitiator()` и `requireInitiator()`. Контекст инициатора должен сохраняться через асинхронные продолжения; одновременно отслеживается завершение активных initiator runs при disposal.

Это **главный blocker Agent Core**. Простая замена на глобальную переменную или стек не сохранит корректность при конкурентных async-задачах одного invocation. Требуется отдельный дизайн явной передачи инициатора через execution context/Agent scope либо другой механизм, который будет подтверждён тестами. `isPromise` — меньшая Node-specific зависимость, но замена тоже должна сохранить контракт точного Promise-return поведения.

##### Что это означает для Serverless-модели

В исходном DSH `AgentLoop` оборачивает полный lifetime driver в `ctx.agents.withInitiator(agent, ...)`. Потребители ambient initiator включают goal tools, web-search/web API integrations и browser-use plugins; фоновые schedule/goal drivers используют `withoutInitiator()`.

Для Telegram Serverless возможны две модели:

1. **Один Cordis root и один активный Agent на invocation.** Каждый Telegram Update или Mini App endpoint создаёт собственный runtime, восстанавливает только выбранную сессию/агента, выполняет один запрос и закрывает runtime. Разные пользователи и разные агенты выполняются в разных invocation. Это позволяет реализовать ограниченный invocation-local initiator без межагентной конкуренции. Плагины, запускающие независимую фоновую работу через `withoutInitiator()`, не входят в первый runtime.
2. **Несколько активных Agent в одном invocation.** Тогда ambient initiator нельзя корректно заменить простым полем/глобальной переменной. Нужна более широкая миграция plugin APIs на явный Agent/ExecutionContext и обновление всех потребителей `currentInitiator()`/`requireInitiator()`.

Для первой версии платформы вариант 1 выглядит естественным: Serverless invocation обрабатывает один конкретный update/request, а список пользовательских агентов — это выбор агента между запросами, не одновременное выполнение всех агентов в одном runtime. Это пока предложение, требующее подтверждения продуктового инварианта.

#### `@deepseek-ai/dsh-agent-loop`

Файл: `packages/core/agent-loop/src/index.ts`

Прямой Node import:

- `node:crypto` — `randomUUID`.

В репозитории уже есть `@deepseek-ai/dsh-util-crypto.randomUUID()`, основанный на `crypto.getRandomValues`. Вероятный минимальный патч — использовать существующий helper. Доступность Web Crypto в Telegram V8 должна быть проверена отдельным runtime smoke test.

#### `@deepseek-ai/dsh-llm-deepseek`

Текущий provider не является готовым Serverless adapter:

- основной transport вызывает обычный `fetch`, тогда как Telegram документирует исходящую сеть через `sdk/fetch`;
- `file-store.ts` импортирует `node:timers/promises`;
- `files-api.ts` импортирует `node:crypto`;
- текущая композиция provider включает локальные file/credential/home-path capabilities и loader-зависимости.

В `@deepseek-ai/dsh-llm` есть абстрактный `LlmAdapter`. Поэтому Serverless вариант следует реализовать как отдельный адаптер, который использует `sdk/fetch` и выдаёт стандартные DSH `StreamChunk`. Не переносить локальное хранилище файлов, пока не появится отдельное требование на attachments.

#### `@deepseek-ai/dsh-session-persistence-jsonl`

Не подходит для Serverless: использует `node:fs`, `node:fs/promises`, `node:path`, `node:perf_hooks`, `node:timers/promises`, `node:crypto`, Buffer, worker и файловые leases.

#### `@deepseek-ai/dsh-session-persistence-sqlite`

Название не означает совместимость с Telegram SQLite. Текущий provider использует:

- `node:sqlite`;
- `node:fs/promises`;
- `node:path`;
- `node:crypto`;
- native addon `@deepseek-ai/node-addon-system` и `koffi`;
- legacy JSONL backend и файловые routing/lease records.

Его нельзя использовать напрямую. Нужен новый backend, реализующий тот же DSH persistence contract через Telegram `sdk/db`.

## 4. Session Persistence: контракт и риск

Файлы контракта:

- `packages/session/session-persistence/src/index.ts`
- `packages/session/session-persistence/src/handle.ts`

Сервисный контракт включает:

- `create(header, options)`;
- `open(id, access, options)`;
- `flush()`;
- `stat(id, options)`;
- `list(options)`.

Каждый handle включает:

- `read(offset, length, options)`;
- `append(events, options)`;
- `flush(options)`;
- `close()`.

Контракт требует contiguous event sequence, single-writer ownership, read freshness после подтверждённых append/flush и явную durability barrier. DSH Session остаётся append-only журналом; LLM history строится из событий.

Telegram SDK документирует SQLite query builder, raw SQL, `INSERT ... RETURNING`, `ON CONFLICT` и асинхронные запросы. Но опубликованная документация **не подтверждает наличие транзакционного API, гарантий конкурентного CAS для нескольких invocation, lock/lease semantics или точной durability-гарантии для каждой операции**.

Поэтому нельзя пока утверждать, что адаптер можно безопасно реализовать простой последовательностью отдельных SQL-вызовов.

### Обязательный SQLite spike

До реализации persistence provider проверить в Telegram Serverless:

1. можно ли выполнить несколько SQL-операций атомарно в одной транзакции;
2. гарантирует ли SDK атомарность одного `UPDATE ... WHERE revision = expected` и достоверно ли сообщает `rowsAffected`;
3. поведение двух одновременных invocation, которые append-ят один session;
4. поведение при повторном append после неопределённого результата вызова;
5. гарантии видимости записи из следующего invocation;
6. доступность SQL-конструкций, нужных для атомарного append и lease claim.

Если транзакции недоступны, надо выбрать storage layout, который позволяет выполнить commit одним атомарным SQL statement, либо изменить persistence strategy. Это решение нельзя принимать без spike.

Дополнительно: Telegram SQLite не поддерживает foreign keys. Целостность owner/session/agent relationships придётся обеспечивать в application layer и запросах с tenant scope.

Официальный источник: https://blogfork.telegram.org/bots/serverless

## 5. Плагины и инструменты

### HTTP plugins

Плагин хранит декларативный manifest: tools, JSON Schema, HTTP method/endpoint, auth configuration, timeout и policy. Выполнение делает платформенный executor через `sdk/fetch`.

В manifest и пользовательской конфигурации нельзя разрешать произвольные URL без проверки назначения: HTTP executor должен закрывать SSRF и доступ к внутренним адресам, ограничивать ответ и не раскрывать credentials модели.

### Программные DSH/Cordis plugins

Cordis core можно оставить основой plugin lifecycle. Но runtime не может динамически ставить npm-пакеты или читать произвольные plugin-файлы с диска.

Следовательно:

- программные плагины включаются в deploy bundle заранее;
- каталог и allowlist определяют, какие из поставляемых плагинов разрешены платформой;
- user/agent activation хранится в SQLite;
- Cordis contexts/scopes создаются из разрешённого статического набора;
- пользовательский JS не исполняется как plugin code.

Плагинный каталог DSH, который управляет npm install, filesystem bundles или локальным HMR, не переносится в Serverless runtime.

## 6. Временные границы и современные JS API

Корневой DSH workspace заявляет Node engine `^24.22.3 || >=26.13.1`. Это требование относится к полному development/build workspace, а не доказывает, что минимальный runtime обязан запускаться на Node.

В проверенных core-файлах встречаются современные JS API и конструкции: `structuredClone`, `Promise.withResolvers`, `AbortSignal.any`, `Array.prototype.toReversed`, async iterators и explicit resource management. Совместимость этих API с Telegram V8 пока не подтверждена опубликованной таблицей версий. Нужен smoke-test на реальном Serverless runtime.

Официальная документация также не даёт в открытом разделе, изученном для этого аудита, точного максимального времени одного invocation. До выяснения лимита нельзя проектировать один Agent Loop как гарантированно долгоживущую задачу.

## 7. Рекомендуемый порядок реализации

1. **Runtime smoke test:** проверить global Web Crypto, AbortController/AbortSignal, structuredClone, Promise.withResolvers, async iterators, TextEncoder/Decoder и streaming `sdk/fetch`.
2. **Bundle spike:** собрать минимальный Cordis + Session + Tools + LLM core в deployable `tgcloud/lib/*.js`, оставив SDK imports external.
3. **Agent initiator refactor:** устранить `AsyncLocalStorage` без потери изоляции параллельных async-операций; добавить regression tests.
4. **Agent Loop ID seam:** заменить Node crypto на browser-safe helper или инъецируемый ID provider.
5. **LLM adapter:** реализовать адаптер через `sdk/fetch`; отдельно решить provider endpoint и модель credentials.
6. **SQLite spike:** подтвердить atomicity/concurrency/durability, затем реализовать Telegram persistence provider.
7. **Plugin composition:** статически поставляемые Cordis plugins + декларативные HTTP plugins.
8. **End-to-end:** Mini App endpoint → tenant context → resume/create Agent → LLM stream → tool HTTP → session flush → ответ.

## 8. Не решено и не должно угадываться

- Официальный DeepSeek API или другой OpenAI-compatible endpoint.
- Общий API key платформы или BYOK (пользовательские ключи).
- Максимальное время invocation и стратегия continuation для длинных задач.
- Транзакционная и конкурентная семантика Telegram SQLite SDK.
- Точный build/import mechanism для сборки DSH в `tgcloud/`.

Эти пункты требуют решений или проверок до production-реализации. Аудит не является подтверждением успешного запуска; реальный `tgcloud run`/deployment пока не выполнялся.

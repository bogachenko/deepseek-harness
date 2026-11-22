# Аудит совместимости DeepSeek Harness с Telegram Serverless

> **Строгое правило:** адаптируем DSH к Telegram Serverless, а не переделываем DSH под наши предположения. Сохраняем существующие адаптеры, API/protocols, контракты и поведение. Сначала доказываем несовместимость, затем выбираем минимальную адаптацию на границе runtime/transport/dependency. Изменение существующей функциональности — только при доказанной необходимости и после отдельного согласования. Полная рамка: [project scope](https://github.com/bogachenko/dsh-telegram-platform/blob/main/docs/project-scope.md#строгое-правило-адаптации-dsh).

## 0. Повторная проверка официальной документации Telegram Serverless

Источник: [официальная документация Telegram Serverless](https://blogfork.telegram.org/bots/serverless), проверена 22 ноября 2026 года.

Подтверждено документацией:

- `sdk/fetch` поддерживает потоковое чтение ответа через `for await (const chunk of response.body)`; это позволяет принимать SSE/token stream без Node `fetch`. Общий размер ответа ограничен 30 MB.
- Текущий DSH parser `packages/llm/llm-deepseek/src/sse.ts` принимает Web `ReadableStream` и использует `TextDecoderStream` + `eventsource-parser`. Telegram SDK описывает тело ответа как async iterable. Serverless adapter должен преобразовать async iterable в поддерживаемый parser input либо иметь собственный SSE framing parser. Сам SDK stream не следует считать Web `ReadableStream` без проверки.
- Database SDK предоставляет асинхронные запросы, raw SQL (`db.run/all/get/values`), `RETURNING`, `ON CONFLICT` и `rowsAffected`. Это подтверждает необходимые базовые SQL building blocks, но документация не описывает API транзакций, isolation level, CAS/concurrency guarantees или durability barrier.
- `PRAGMA foreign_keys` выключен; ссылки на tenant/session/agent должны проверяться приложением и включать tenant scope в запросы.
- Runtime принимает только SDK imports (`sdk`, `sdk/db`, `sdk/fetch`) и относительные imports собственных модулей с расширением `.js`. Внешние npm imports не разрешаются; deployable JS должен находиться внутри `tgcloud/`.

Следствия для реализации:

1. LLM transport через SDK технически поддерживает streaming. Существующие DSH LLM adapters и поддерживаемые ими API/protocols сохраняются; выбирать один протокол вместо другого не требуется. В ветке добавлена необязательная Cordis service `serverlessFetch`: `llm-pi-ai` использует существующий fetch option pi-ai, `llm-deepseek` — необязательную fetch dependency. Для Node hosts поведение остаётся прежним. Отдельно нужно определить только credential policy.
2. Нельзя переносить `eventsource-parser` как обычную runtime npm dependency. Его нужно либо исключить из deployable closure, либо включить необходимую реализацию в собственные `tgcloud/lib/*.js`.
3. SQLite persistence нельзя строить на предположении о multi-statement transactions. Сначала требуется проверить реальные гарантии SDK; допустимый дизайн должен явно обеспечивать single-writer fencing, contiguous append, идемпотентность и durability.
4. Сборка DSH должна включить все нужные зависимости в собственные JS-модули внутри `tgcloud/`; импортировать пакеты из `node_modules` в runtime нельзя.

Пункты выше подтверждают возможности и ограничения по документации, но не заменяют runtime spike через `tgcloud run` и проверку на реальном deployment.


> Границы задачи проекта зафиксированы в [dsh-telegram-platform/docs/project-scope.md](https://github.com/bogachenko/dsh-telegram-platform/blob/main/docs/project-scope.md). Этот аудит — техническая часть этой задачи, а не расширение её scope.

- **Дата:** 2026-11-22
- **Ветка:** `telegram-serverless-adaptation`
- **База аудита:** `master` форка, синхронизированный с upstream на момент начала работ
- **Статус:** аудит исходников, V8-compatible single-Agent scope и browser-safe UUID seam; runtime-проверка на Telegram Serverless ещё не проводилась

## 1. Вывод

Полностью запустить стандартную Node.js-сборку DSH в Telegram Serverless нельзя. Но базовые части агентной архитектуры выглядят переносимыми: Cordis core, Session event model, Tool Registry и provider-neutral LLM API не требуют локального сервера по своей концепции.

В проверенной части core runtime прямые Node imports удалены из `dsh-agent`, `dsh-agent-loop`, `dsh-session` и provider-neutral `dsh-llm`. Для работающего Serverless runtime остаются три основные адаптации и одна runtime-проверка:

1. проверить доступность `globalThis.crypto.getRandomValues` в реальном Telegram V8 invocation; browser-safe UUID seam уже добавлен через `dsh-util-crypto`;
2. передать Telegram SDK `sdk/fetch` в существующие LLM adapters через необязательный Cordis service `serverlessFetch`; provider protocols и request semantics не менять;
3. реализовать собственный `SessionPersistence` поверх Telegram SQLite SDK;
4. собрать выбранное подмножество DSH в deployable `.js` modules внутри `tgcloud/` и проверить module resolution.

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

#### `@deepseek-ai/dsh-agent` и initiator scope

В исходном `dsh-agent` прямые импорты Node built-ins удалены. `AgentRegistry` делегирует ambient attribution через `AgentInitiatorScopeFactory`; scope создаётся отдельно для каждого lifecycle экземпляра AgentRegistry.

Добавлены два provider:

- `@deepseek-ai/dsh-agent-initiator-node` — Node `AsyncLocalStorage` implementation, сохраняющая независимую идентичность для нескольких параллельных Agent. Стандартные Node bundles `dsh-base` и `dsh-sdk-minimal` явно подключают этот provider.
- `@deepseek-ai/dsh-agent-initiator-single` — V8-compatible provider без Node imports. Он также является fallback внутри `dsh-agent`, когда отдельный provider не смонтирован.

Для Telegram Serverless подтверждён продуктовый инвариант: **один Cordis root и один активный Agent на invocation**. Single provider разрешает вложенные и пересекающиеся async boundaries только для того же Agent. Он отклоняет запуск второго Agent и `withoutInitiator()`, пока активен первый Agent. Agentless direct operations разрешены до/после Agent run, но не параллельно с ним.

Это сознательное ограничение single-invocation runtime, а не замена tenant authorization. В Serverless composition нельзя подключать background schedulers, subagent drivers или queue pumps, запускающие отдельные ambient boundaries внутри того же invocation. Request owner должен дождаться завершения Agent driver и foreground work до disposal Cordis root.

Regression tests добавлены для single-Agent scope; полный Node provider продолжает обслуживать стандартные DSH compositions.

#### `@deepseek-ai/dsh-agent-loop`

Файл: `packages/core/agent-loop/src/index.ts`

Первоначальный `node:crypto.randomUUID` заменён на `@deepseek-ai/dsh-util-crypto.randomUUID()`. Helper использует `globalThis.crypto.getRandomValues`, поэтому Node built-in из Agent Loop удалён. Официальная документация Telegram Serverless не перечисляет Web Crypto в явном перечне SDK API; доступность `crypto.getRandomValues` должна быть подтверждена runtime smoke test на реальном invocation.

#### `@deepseek-ai/dsh-session`

В `packages/core/session/src/validation.ts` использовался `node:path.isAbsolute()` для проверки `cwd` в Session header. Node built-in удалён; добавлена локальная проверка абсолютного пути с POSIX-семантикой по умолчанию и Windows-семантикой, если `globalThis.process.platform === 'win32'`. Это убирает Node dependency из Session core, сохраняя поведение Node на Windows.

#### `@deepseek-ai/dsh-llm-deepseek`

Текущий provider не является готовым Serverless adapter:

- основной transport вызывает обычный `fetch`, тогда как Telegram документирует исходящую сеть через `sdk/fetch`;
- `file-store.ts` импортирует `node:timers/promises`;
- `files-api.ts` импортирует `node:crypto`;
- текущая композиция provider включает локальные file/credential/home-path capabilities и loader-зависимости.

Существующие `llm-deepseek` и `llm-pi-ai` adapters сохраняются. В `llm-pi-ai` Telegram transport передаётся через уже существующий `pi-ai` fetch option; в `llm-deepseek` добавлена необязательная fetch dependency, которая используется для Messages requests, model listing и Files API. Host получает её из Cordis service `serverlessFetch`. Если service не предоставлен, оба adapters продолжают использовать обычный `globalThis.fetch`, то есть прежнее поведение Node не меняется. Отдельный LLM adapter и выбор одного API protocol не нужны.

Оставшиеся Node-only зависимости в `file-store.ts` (`node:timers/promises`) и `files-api.ts` (`node:crypto`) пока не адаптированы. Нельзя решать эту несовместимость удалением Files API/image features: сначала заменить только неподдерживаемые primitives на совместимые реализации и покрыть прежнее поведение тестами.

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

1. **Runtime smoke test:** проверить global Web Crypto (`crypto.getRandomValues`), `btoa`/`atob`, AbortController/AbortSignal, structuredClone, Promise.withResolvers, async iterators, TextEncoder/Decoder и streaming `sdk/fetch`.
2. **Bundle spike:** собрать минимальный Cordis + Session + Tools + LLM core в deployable `tgcloud/lib/*.js`, оставив SDK imports external.
3. **Agent initiator scope:** выполнено — Node-specific `AsyncLocalStorage` вынесен в отдельный provider, а V8-compatible single-Agent provider добавлен с regression tests. Требуется runtime smoke test на Telegram.
4. **Agent Loop ID seam:** выполнено — Agent Loop использует browser-safe `dsh-util-crypto.randomUUID()`. Требуется проверить `crypto.getRandomValues` на реальном Serverless invocation.
5. **LLM transport:** выполнено на уровне source integration — существующие adapters получают необязательный `serverlessFetch` service; добавлены тесты для pi-ai provider routing, DeepSeek Messages requests и model listing. Осталось проверить runtime globals и SDK stream на Telegram Serverless; адаптировать оставшиеся Node-only helpers, не удаляя LLM/File API features.
6. **SQLite spike:** подтвердить atomicity/concurrency/durability, затем реализовать Telegram persistence provider.
7. **Plugin composition:** статически поставляемые Cordis plugins + декларативные HTTP plugins.
8. **End-to-end:** Mini App endpoint → tenant context → resume/create Agent → LLM stream → tool HTTP → session flush → ответ.

## 8. Не решено и не должно угадываться

- Credential policy для существующих LLM providers: общий ключ платформы, BYOK или оба варианта.
- Общий API key платформы или BYOK (пользовательские ключи).
- Максимальное время invocation и стратегия continuation для длинных задач.
- Транзакционная и конкурентная семантика Telegram SQLite SDK.
- Точный build/import mechanism для сборки DSH в `tgcloud/`.

Эти пункты требуют решений или проверок до production-реализации. Аудит не является подтверждением успешного запуска; реальный `tgcloud run`/deployment пока не выполнялся.

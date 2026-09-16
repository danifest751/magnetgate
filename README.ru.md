# magnetgate

**Переход на 0.11:** native-сессии и зашифрованные конверты discovery используют wire version 4.
Клиенты и exit нужно обновлять совместно: старые версии не читают новые конверты.
Требуется Node.js 20.19+; для сборки desktop — 22.12+. Перед обновлением запустите `npm test`.
Отдельная firewall-защита desktop пока требует полевого теста отказов/восстановления Windows;
одного `strict_route` недостаточно после завершения движка.

> Устойчивый к цензуре туннель **без брокера и с рандеву без фиксированного адреса**: клиент сам
> находит exit по двум независимым каналам и подключается через камуфляж-дата-плоскость. Сам exit —
> по-прежнему один адрес и один порт, см. ниже.

**EN:** [README.md](README.md)

Exit-нода публикует подписанный и зашифрованный **offer** в публичную инфраструктуру; клиент находит
его по общему секрету (PSK) и подключается — предпочитая сильно замаскированную дата-плоскость
(Reality / hysteria2) и откатываясь на собственный forward-secret канал magnetgate. Централизованного
брокера нет: рандеву идёт через BitTorrent Mainline DHT **и** пул Nostr-релеев, а дата-плоскость
выглядит как обычный TLS / QUIC к реальному сайту.

**Что это значит и чего не значит.** В *рандеву* нет фиксированного адреса, который цензор мог бы
просто заблокировать, и посредника между сторонами тоже нет. Но *exit* — это по-прежнему один
`host:port`: ротация кредов делает его «новым» на проводе, но адрес не меняет, поэтому блокировка по
адресу останавливает работу до появления exit-overlay (entry/egress split, `ROADMAP.md` §4). Это
инструмент для небольшой доверенной группы, а не инфраструктура анонимности — см. «Известные
ограничения» ниже.

## Как это работает

```
Приложение ─▶ SOCKS5 127.0.0.1:1080  (клиент magnetgate, split-tunnel: direct / proxy)
                    │
                    ▼   дата-плоскость выбирается на каждое соединение, с авто-фейловером:
   ┌─ Reality (VLESS+Reality, TCP/443)  ─┐
   ├─ hysteria2 (QUIC, UDP/443)          ─┼─▶ sing-box ─▶ exit ─▶ CONNECT host:port ─▶ цель
   └─ native mgt (forward-secret mux)    ─┘   (native идёт на exit :49001)

Рандеву — как клиент узнаёт exit и его текущие эндпоинты — по ДВУМ независимым каналам:
   Mainline DHT (BEP 44, mutable, ed25519)   +   Nostr-релеи (kind 30078, secp256k1)
   exit публикует один подписанный+зашифрованный offer (список дата-плоскостей) в оба
```

Все ключи детерминированно выводятся из PSK (`mgt-sig:` / `mgt-salt:` / `mgt-box:` / `mgt-nostr:`),
поэтому не нужны домены, сертификаты, трекеры и брокеры. Offer запечатан secretbox под PSK (прочитать
или подделать может только держатель PSK). **Нативный** канал добавляет forward-secret хендшейк
(эфемерный X25519, аутентифицированный под PSK, с защитой от replay), так что последующая утечка PSK
не расшифровывает записанный ранее нативный трафик; Reality и hysteria2 приносят свой изученный
камуфляж и транспорт.

## Дата-плоскости

Offer объявляет список (`dp`) дата-плоскостей. Клиент выбирает по приоритету и фейловерит при ошибке:

| Плоскость | Транспорт | Роль | Примечания |
|---|---|---|---|
| **Reality** | VLESS+Reality поверх TLS 1.3 (TCP/443) | основная | заимствует TLS-хендшейк реального сайта (SNI); лучшая против SNI/DPI |
| **hysteria2** | QUIC (UDP/443) + salamander obfs | альтернатива | хороша на потерях/мобиле; серверный cert пиннится через Nostr-offer |
| **native `mgt`** | AEAD-мультиплекс поверх TCP (или reliable-UDP) на :49001 | fallback | forward-secret, без сторонних бинарей, всегда доступна |

Reality и hysteria2 запускает **встроенный sing-box** на клиенте (`scripts/get-singbox.ps1`, с
пиннингом SHA-256); magnetgate генерит его конфиг из offer'а, супервизит процесс и маршрутит прокси-
соединения через него. `MAGNETGATE_DATA_PLANE=mgt` форсит только нативный канал.

## Быстрый старт

**Exit (VPS с публичным IPv4):**
```bash
# 1) рандеву + нативный канал magnetgate (непривилегированно, systemd-юниты в systemd/)
npm ci
MAGNETGATE_PSK='<psk>' MAGNETGATE_PORT=49001 MAGNETGATE_PUBLIC_HOST=<PUBLIC_IP> \
MAGNETGATE_SEQ_FILE=/var/lib/magnetgate/seq \
DHT_BOOTSTRAP=127.0.0.1:20001,router.bittorrent.com:6881 node src/exit.js

# 2) дата-плоскости Reality + hysteria2 (sing-box) — разовая настройка, далее ежедневная ротация
MAGNETGATE_PUBLIC_HOST=<PUBLIC_IP> bash scripts/setup-singbox.sh
```

**Клиент (локальная машина):**
```powershell
npm ci
powershell -ExecutionPolicy Bypass -File scripts\get-singbox.ps1   # движок дата-плоскости
node src/client.js .\magnetgate.config.json                        # или: node src/client.js "<psk>" 1080
```

**Проверка:**
```powershell
curl.exe --socks5-hostname 127.0.0.1:1080 http://checkip.amazonaws.com/   # → IP exit'а
curl.exe --socks5-hostname 127.0.0.1:1080 https://www.youtube.com/robots.txt
```

Браузер: SwitchyOmega / FoxyProxy → SOCKS5 `127.0.0.1:1080`. DNS резолвится на exit'е
(SOCKS5-домены), локальное отравление резолвера исключено.

## Рандеву (два канала)

Exit публикует sealed-offer в оба канала — одно поколение и один `ts`, но не байт-в-байт: вид для DHT
компактный (без hysteria2-эндпоинта, чей пришпиленный сертификат не влезает в лимит BEP 44 ~1000 Б), а
вид для Nostr его содержит. Клиент сливает их по типу дата-плоскости. Поэтому discovery переживает
блокировку или шейпинг любого из каналов:

- **Mainline DHT (BEP 44)** — mutable-запись по ключу ed25519 из PSK; republish каждые 60 с. Ставьте
  в `DHT_BOOTSTRAP` первой IPv4-ноду (часть публичных bootstrap'ов только IPv6, а bittorrent-dht —
  udp4); свой bootstrap на exit'е (`:20001`) — самый надёжный.
- **Nostr-релеи** — parameterized-replaceable событие (kind 30078) под ключом secp256k1 из PSK,
  доставляется push и мгновенно новым подписчикам. Пул задаётся `MAGNETGATE_NOSTR_RELAYS`, отключение
  — `MAGNETGATE_NOSTR=off`.

## Split-tunneling

`MAGNETGATE_RULES=path/to/rules.json` (или `rules` в конфиге клиента):
```json
{ "direct": ["ru", "*.local"], "proxy": [] }
```
При непустом `direct` всё несовпавшее идёт через туннель; при заданном непустом `proxy` — наоборот,
только перечисленное через туннель, остальное напрямую.

## Переменные окружения

| Переменная | Значение |
|---|---|
| `MAGNETGATE_PSK` | PSK exit'а из окружения, чтобы не попадать в argv/`ps` (argv — запасной вариант) |
| `MAGNETGATE_PORT` / `MAGNETGATE_PUBLIC_HOST` | порт нативного канала и публичный хост в offer'е |
| `MAGNETGATE_NODE_SLOT` / `MAGNETGATE_NODE_NAME` | exit: какой слот рандеву занимает нода (по умолчанию `0` — одиночная схема) и её имя в offer'е; две ноды делят один PSK, занимая разные слоты |
| `MAGNETGATE_SLOTS` | клиент: слоты через запятую, например `0,1` — тогда один PSK находит все ноды набора (то же, что `slots` в файле конфигурации) |
| `MAGNETGATE_PEER_SLOTS` | exit: какие слоты нода проверяет и анонсирует в `peers`, например `0,1`; если не задано — сканирования нет, а клиент, знающий один слот, сам узнаёт остальные |
| `MAGNETGATE_EXPECT_PEERS` | exit: писать `[alert]`, если ответило меньше N слотов-соседей (не задано — никогда) |
| `MAGNETGATE_SLOT_DISCOVERY` | клиент: `0` — не добавлять слоты из списка `peers` (добавление всегда пишется в лог) |
| `MAGNETGATE_PUBLISH_MS` | exit: период публикации (по умолчанию 60000); уменьшать только для тестов |
| `DHT_BOOTSTRAP` | CSV bootstrap-нод; **первой IPv4-ноду**, свой `:20001` рекомендуется |
| `MAGNETGATE_SEQ_FILE` | персистентность `seq` (обязательно на exit: рестарты инкрементируют, иначе нонс offer может повториться) |
| `MAGNETGATE_NOSTR` / `MAGNETGATE_NOSTR_RELAYS` | отключить Nostr-канал / переопределить пул релеев |
| `MAGNETGATE_DATA_PLANE` | клиент: `auto` (по умолчанию — Reality/hysteria2, иначе native) или `mgt` (только native) |
| `MAGNETGATE_RULES` | файл правил split-tunnel (клиент) |
| `MAGNETGATE_SOCKS_HOST` | адрес bind SOCKS5-клиента (по умолчанию `127.0.0.1`; не открывать в LAN) |
| `MAGNETGATE_ALLOW_PRIVATE` | exit: `1` разрешает CONNECT к loopback/link-local/RFC1918 (по умолчанию заблокировано — защита от SSRF) |
| `MAGNETGATE_MAX_SESSIONS` / `MAGNETGATE_MAX_STREAMS` | лимиты exit'а (по умолчанию 512 / 256 на сессию) |
| `MAGNETGATE_UDP_IDLE_MS` | exit: закрыть reliable-UDP-стрим после стольких мс молчания (по умолчанию 600000); иначе исчезнувший пир навсегда занимает слот |
| `MAGNETGATE_HEALTH_FILE` | exit: писать в этот файл состояние публикации (последний put, число нод, счётчик неудач) |
| `MAGNETGATE_ALERT_AFTER` | exit: предупреждать после N публикаций подряд, не достигших ни одной DHT-ноды (по умолчанию 5) |
| `MAGNETGATE_TRANSPORT` | нативный канал: `tcp` (по умолчанию) или `udp` (экспериментальный reliable-UDP) |
| `MAGNETGATE_REALITY_SNI` | exit: сайт, чей TLS заимствует Reality (по умолчанию `www.microsoft.com`) |
| `MAGNETGATE_STATS` | клиент: логировать счётчики трафика по exit'ам каждые N секунд |
| `MAGNETGATE_LOG_TARGETS` | клиент: `1` пишет полные имена целевых хостов; по умолчанию в лог идёт только 8-символьный хеш, чтобы лог не превращался в историю посещений |

## Конфигурация и автостарт

Конфиг клиента (`magnetgate.config.json`, пример в `magnetgate.config.example.json`):
```json
{
  "localPort": 1080,
  "dataPlane": "auto",
  "bootstrap": ["<exit-ip>:20001", "router.bittorrent.com:6881"],
  "rules": { "direct": ["ru"], "proxy": [] },
  "exits": [
    { "name": "nl", "psk": "<psk>" },
    { "name": "backup", "psk": "<другой-psk>" }
  ]
}
```
Несколько exit'ов: клиент находит offer'ы всех, раскладывает стримы round-robin'ом и автоматически
фейловерится на здоровый (мёртвый уходит в cooldown на 30 с).

Автостарт в Windows (планировщик при логоне):
```powershell
powershell -ExecutionPolicy Bypass -File scripts\install-client-windows.ps1 -ConfigPath .\magnetgate.config.json
```
Linux-автостарт: `scripts/magnetgate-client.service` (шаблон systemd-юнита).

## Ротация кредов

`scripts/rotate-dp.mjs` (ежедневный systemd-таймер, ставится `setup-singbox.sh`) ротирует Reality
shortId+uuid и пароль hysteria2, сохраняя предыдущее поколение валидным один интервал (**grace-окно**)
и сохраняя стабильную identity (reality-keypair / hy2-obfs / cert — чтобы пиннинг клиента не ломался).
Exit watch'ит dp-файл и republish'ит за ~1 с, так что клиенты получают новые креды за секунды; клиент
чисто переключает sing-box на новые параметры и на любом разрыве падает на нативный канал. Вручную:
`systemctl start magnetgate-rotate.service`.

## Режим системного VPN (Windows)

SOCKS5-клиент — это дата-плоскость; чтобы завернуть **весь системный трафик**,
[tun2proxy](https://github.com/tun2proxy/tun2proxy) создаёт TUN-адаптер и подаёт всё в
`127.0.0.1:1080` (DNS резолвится на exit'е). IP exit'а авто-байпасится, чтобы собственный аплинк
клиента не перехватывался:

```powershell
# из PowerShell с правами администратора:
powershell -ExecutionPolicy Bypass -File scripts\vpn-windows.ps1        # подключить (скачает tun2proxy, pinned)
powershell -ExecutionPolicy Bypass -File scripts\vpn-windows.ps1 -Off   # отключить
```
> Desktop управляет TUN sing-box и сохраняет native fallback. Full допускает direct-исключения,
> Split направляет в туннель выбранные ресурсы. Строгая firewall-опция Full отключает исключения
> и сохраняется после закрытия приложения до явного Disconnect. Старые PowerShell-лаунчеры
> постоянной firewall-защиты не дают. Подробности — [app/README.md](app/README.md).

## Деплой (pull-based автодеплой)

Сервер сам подтягивает `main` с GitHub (без GitHub Actions и открытых портов):
```bash
# корень репозитория == /opt/magnetgate
git init && git remote add origin https://github.com/danifest751/magnetgate.git
git fetch origin && git checkout -f -B main origin/main

# непривилегированный сервисный пользователь + каталог состояния + файл секретов (не в git)
useradd --system --no-create-home --shell /usr/sbin/nologin magnetgate
install -d -o magnetgate -g magnetgate -m 750 /var/lib/magnetgate
umask 077 && cat > /etc/magnetgate.env <<'ENV'
PSK=<ваш-128-битный-psk>
MAGNETGATE_PORT=49001
MAGNETGATE_PUBLIC_HOST=<PUBLIC_IP>
DHT_BOOTSTRAP=127.0.0.1:20001,router.bittorrent.com:6881
ENV
chown root:magnetgate /etc/magnetgate.env && chmod 640 /etc/magnetgate.env

cp systemd/*.service systemd/*.timer /etc/systemd/system/
systemctl daemon-reload && systemctl enable --now magnetgate-exit magnetgate-dht magnetgate-health.timer magnetgate-deploy.timer

# дата-плоскости (Reality + hysteria2 + ежедневная ротация):
MAGNETGATE_PUBLIC_HOST=<PUBLIC_IP> bash scripts/setup-singbox.sh
```

`magnetgate-deploy.timer` каждые 3 минуты запускает `scripts/deploy.sh`: fetch → hard reset на
`origin/main` → `npm ci` (только если менялся lockfile) → копирование изменённых юнитов → рестарт
сервисов. Exit, DHT и sing-box работают под непривилегированными пользователями в песочницах systemd
(`NoNewPrivileges`, `ProtectSystem=strict`, сброшенные capabilities). Файл `/opt/magnetgate/.deploy-verify`
заставит деплой требовать подписанный коммит (`git verify-commit`) перед запуском кода от root. (Деплой
рестартит только exit/DHT magnetgate; sing-box не трогается, поэтому Reality/hysteria2-сессии переживают
обновления.)

## Документация

Дизайн-заметки, ТЗ, методика испытаний и ресёрч (с планом на 2026) лежат во внутренней папке `docs/`,
намеренно не публикуемой в репозитории. Отчёты об испытаниях хранятся внутри и в репозиторий не попадают.
Юнит-тесты: `npm test` (node:test). Правила коммитов: [CONTRIBUTING.md](CONTRIBUTING.md)
(Conventional Commits, только английский, проверяется хуком `commit-msg`).

## Статус

Реализовано и проверено в проде:

- **Рандеву** по двум независимым каналам — Mainline DHT (BEP 44) + Nostr — с авто-слиянием/фейловером;
  offer'ы подписаны и зашифрованы под PSK.
- **Дата-плоскости** — Reality (основная) и hysteria2 (альтернатива) через встроенный sing-box, плюс
  нативный forward-secret мультиплекс как всегда доступный fallback; выбор и фейловер на каждое соединение.
- **Ротация кредов** с grace-окном и распространением за ~1 с.
- **Харденинг** — exit/DHT/sing-box работают непривилегированно в песочницах systemd; PSK не попадает
  в командную строку; exit блокирует egress на loopback/link-local/RFC1918 (защита от SSRF) и
  ограничивает число сессий/стримов; SOCKS слушает только loopback; скачанные бинарники пиннятся по
  SHA-256; `npm ci` для воспроизводимых установок. Все скачиваемые и встраиваемые сторонние артефакты
(sing-box, wintun, tun2proxy, rule-set'ы маршрутизации) запинены в `scripts/pins.json`, который читают
скрипты загрузки — изменённый upstream-файл останавливает загрузку, а не тихо переписывает маршруты.
`scripts/check-hygiene.mjs` (подключён к pre-commit-хуку) не даёт закоммитить приватные ключи,
токены, полевые отчёты и реальные адреса хостов.

Известные ограничения: обфускация нативного
канала на PoC-уровне, а DHT видит IP участников put/get как у обычной BT-ноды. Target рандеву выводится
из PSK, так что тот, кто знает — или сбрутит слабый — PSK, найдёт exit: **используйте случайный PSK ≥128 бит.**

## Роадмап

> Подробно, включая дизайн **overlay-сети (entry/egress split)**, — в [ROADMAP.md](ROADMAP.md).

**Фаза 3:**
- ✅ **Пиннинг cert для hy2** — серверный cert теперь доставляется через Nostr-offer (DHT-offer
  компактный, оба запечатаны разными нонсами), `insecure` для hysteria2 убран.
- **Desktop с TUN sing-box** реализован; полевой тест отказов и восстановления firewall остаётся.

**После Фазы 3:**
- **Дата-плоскость на WebRTC DataChannel** (coturn на exit'е; DTLS выглядит как видеозвонок; встроенный
  NAT-traversal) как ещё один тип `dp` — прямой P2P без фиксированного порта данных.
- **Третий канал рандеву** — dead-drop через DoH / ENS как третичный путь discovery, чтобы в слое 1
  было ≥3 независимых механизма.
- **Мульти-exit** — несколько exit'ов, каждый ротирует Reality/hysteria2; клиент балансирует и
  фейловерит между ними.
- **Мультипат-агрегация** — нести одну сессию сразу по нескольким дата-плоскостям (в духе MPTCP), чтобы
  блокировка одной снижала скорость, а не рвала сессию.
- **Холодный fallback** — email/IMAP store-and-forward для сценариев полного шатдауна.
- **Кроссплатформенные клиенты** — Linux/macOS/Android (sing-box кроссплатформенный) как сервис, плюс
  автопровижининг exit'ов и health/метрики.

## Дисклеймер

Программное обеспечение предоставляется в исследовательских и образовательных целях «как есть», без
каких-либо гарантий (см. [LICENSE](LICENSE)). Авторы не аффилированы с какими-либо платформами и
сервисами, не предоставляют юридических консультаций и не призывают к нарушению законов. Ответственность
за соблюдение законодательства вашей юрисдикции — включая, где применимо, ограничения на использование
и популяризацию средств обхода блокировок — лежит исключительно на вас. Не используйте это ПО в
незаконных целях и во вред другим. Авторы не несут ответственности за использование третьими лицами.

## Лицензия

MIT — см. [LICENSE](LICENSE).

# magnetgate

> SOCKS5-туннель с рандеву через BitTorrent DHT — без доменов, брокеров и фиксированных адресов.

**EN:** [README.md](README.md)

Exit-нода публикует в публичный DHT подписанный (ed25519, BEP 44) и зашифрованный offer; клиент
находит его сам по общему секрету (PSK) и устанавливает прямое шифрованное соединение. Цензор не
видит ни «подозрительного» IP у клиента, ни централизованного брокера — заблокировать рандеву
означает заблокировать Mainline DHT, которым пользуется весь BitTorrent-мир.

## Как это работает

```
Приложение → SOCKS5 127.0.0.1:1080
   ├─ proxy-правила  → AEAD-фреймы → exit (VPS) → CONNECT host:port → цель
   └─ direct-правила → напрямую с машины
Рандеву: exit публикует offer {host,port,ts} в Mainline DHT (BEP 44, mutable, ed25519)
Клиент: get(target) → проверка подписи → расшифровка → connect
```

Ключи идентичности/рандеву детерминированно выводятся из PSK (`mgt-sig:` / `mgt-salt:` /
`mgt-box:`), поэтому никаких доменов, сертификатов, трекеров и брокеров не нужно. Дальше дата-канал
проходит **forward-secret хендшейк** — эфемерный X25519, аутентифицированный и зашифрованный под
PSK, — поэтому ключи сессии эфемерны, и последующая утечка PSK не расшифровывает записанный ранее
трафик. Данные идут аутентифицированными secretbox-фреймами с паддингом по бакетам.

## Быстрый старт

**Exit (VPS с публичным IPv4):**
```bash
npm ci
# PSK читается из окружения, чтобы не попадать в argv / вывод ps
MAGNETGATE_PSK='<psk>' MAGNETGATE_PORT=49001 MAGNETGATE_PUBLIC_HOST=<PUBLIC_IP> \
MAGNETGATE_SEQ_FILE=/var/lib/magnetgate/seq \
DHT_BOOTSTRAP=127.0.0.1:20001,router.bittorrent.com:6881 node src/exit.js
```
(продакшн — systemd-юниты в `systemd/`, работают под непривилегированным пользователем `magnetgate`)

**Клиент (локальная машина):**
```powershell
npm install
$env:DHT_BOOTSTRAP='<exit-ip>:20001'   # self-hosted bootstrap надёжнее публичных
node src/client.js "<psk>" 1080
```

**Проверка:**
```powershell
curl.exe --socks5-hostname 127.0.0.1:1080 http://checkip.amazonaws.com/   # → IP exit'а
curl.exe --socks5-hostname 127.0.0.1:1080 https://www.youtube.com/robots.txt
```

Браузер: SwitchyOmega / FoxyProxy → SOCKS5 `127.0.0.1:1080`.
DNS резолвится на exit'е (SOCKS5-домены), локальное отравление резолвера исключено.

## Split-tunneling

`MAGNETGATE_RULES=path/to/rules.json`:
```json
{ "direct": ["ru", "*.local"], "proxy": [] }
```
При непустом `direct` всё, что не совпало, идёт через туннель; при заданном непустом `proxy` —
наоборот, только перечисленное через туннель, остальное напрямую.

## Переменные окружения

| Переменная | Значение |
|---|---|
| `MAGNETGATE_PSK` | PSK exit'а из окружения, чтобы не попадать в argv/`ps` (argv — запасной вариант) |
| `MAGNETGATE_PORT` / `MAGNETGATE_PUBLIC_HOST` | порт дата-канала и публичный хост, объявляемый в offer |
| `DHT_BOOTSTRAP` | CSV bootstrap-нод. **Первой ставьте IPv4-ноду** — `dht.transmissionbt.com`/`dht.libtorrent.org` на части хостов резолвятся только в IPv6, а bittorrent-dht работает по udp4. Свой узел (`127.0.0.1:20001` на exit, `<exit-ip>:20001` на клиенте) — самый надёжный вариант |
| `MAGNETGATE_SEQ_FILE` | персистентность `seq` (обязательно на exit: рестарты должны инкрементировать, иначе нонс offer может повториться) |
| `MAGNETGATE_RULES` | файл правил split-tunnel (клиент) |
| `MAGNETGATE_SOCKS_HOST` | адрес bind SOCKS5-клиента (по умолчанию `127.0.0.1`; не открывайте в LAN) |
| `MAGNETGATE_ALLOW_PRIVATE` | exit: `1` разрешает CONNECT к loopback/link-local/RFC1918 (по умолчанию заблокировано — защита от SSRF) |
| `MAGNETGATE_MAX_SESSIONS` / `MAGNETGATE_MAX_STREAMS` | лимиты exit'а (по умолчанию 512 сессий / 256 стримов на сессию) |
| `MAGNETGATE_TRANSPORT` | `tcp` (по умолчанию) или `udp` (экспериментальный reliable-UDP транспорт) |
| `MAGNETGATE_STATS` | клиент: логировать счётчики трафика по exit'ам каждые N секунд |

## Конфигурация и автостарт

Конфиг клиента (`magnetgate.config.json`, пример в `magnetgate.config.example.json`):

```json
{
  "localPort": 1080,
  "bootstrap": ["<exit-ip>:20001"],
  "rules": { "direct": ["ru"], "proxy": [] },
  "exits": [
    { "name": "nl", "psk": "<psk>" },
    { "name": "backup", "psk": "<другой-psk>" }
  ]
}
```

Несколько exit'ов: клиент находит offer'ы всех exit'ов, SOCKS-стримы раскладывает round-robin'ом
и автоматически фейловерится на здоровый (мёртвый уходит в cooldown на 30 с).

Автостарт в Windows (планировщик):
```powershell
powershell -ExecutionPolicy Bypass -File scripts\install-client-windows.ps1 -ConfigPath .\magnetgate.config.json
```
Linux-автостарт: `scripts/magnetgate-client.service` (шаблон systemd-юнита).

## Режим системного VPN

Весь системный трафик гонится через клиент `127.0.0.1:1080` утилитой
[ tun2proxy ](https://github.com/tun2proxy/tun2proxy) (TUN-адаптер, DNS уходит в туннель):

```powershell
# из PowerShell с правами администратора:
powershell -ExecutionPolicy Bypass -File scripts\vpn-windows.ps1            # подключить (скачает tun2proxy)
powershell -ExecutionPolicy Bypass -File scripts\vpn-windows.ps1 -Off       # отключить
```

## Деплой (pull-based автодеплой)

Сервер сам подтягивает `main` с GitHub (без GitHub Actions и лишних портов):

```bash
# корень репозитория == /opt/magnetgate
git init && git remote add origin https://github.com/danifest751/magnetgate.git
git fetch origin && git checkout -f main origin/main

# непривилегированный сервисный пользователь + каталог состояния + файл секретов/конфига (не в git)
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
systemctl daemon-reload && systemctl enable --now magnetgate-exit magnetgate-dht magnetgate-deploy.timer
```

`magnetgate-deploy.timer` каждые 3 минуты запускает `scripts/deploy.sh`: fetch → hard reset на
`origin/main` → `npm ci` (только если изменился lockfile) → копирование изменённых systemd-юнитов
→ рестарт сервисов. Exit и DHT работают под непривилегированным пользователем `magnetgate` в
песочнице systemd (`NoNewPrivileges`, `ProtectSystem=strict`, сброшенные capabilities). Файл
`/opt/magnetgate/.deploy-verify` заставит деплой требовать подписанный коммит (`git verify-commit`)
перед запуском нового кода от root. Репо публичное — pull без ключей; если станет приватным,
добавьте read-only deploy key. Ручной запуск: `systemctl start magnetgate-deploy`.

## Документация

Дизайн-заметки, ТЗ, методика испытаний и общий ресёрч лежат во внутренней папке `docs/`, которая
намеренно не публикуется в репозитории. Отслеживаемый отчёт об испытаниях:
[tests/results.md](tests/results.md). Правила коммитов: [CONTRIBUTING.md](CONTRIBUTING.md)
(Conventional Commits, только английский, проверяется хуком `commit-msg`).

## Статус и ограничения

M1–M9 выполнены и испытаны (см. `tests/results.md`): BEP 44 рандеву, SOCKS5 с удалённым DNS,
split-tunneling, мультиплексные сессии (одна постоянная сессия несёт все стримы, keep-alive),
UDP ASSOCIATE-релей и системный VPN-режим. Дата-канал использует forward-secret хендшейк
(эфемерный X25519, аутентифицированный под PSK) с защитой от replay; exit работает
непривилегированно в песочнице systemd, блокирует egress на loopback/link-local/RFC1918 (защита
от SSRF) и ограничивает число сессий/стримов. Юнит-тесты: `npm test`.

Важно: PoC-уровень обфускации — дата-канал маскируется под BitTorrent-семейство лишь частично;
провайдер сервиса (DHT) видит IP-адреса участников put/get как обычный BT-узел, а target рандеву
выводится из PSK (тот, кто знает — или сбрутит слабый — PSK, найдёт exit). Используйте случайный
PSK ≥128 бит. Используйте на свою ответственность и в рамках законов вашей юрисдикции.

## Дисклеймер

Программное обеспечение предоставляется в исследовательских и образовательных целях «как есть»,
без каких-либо гарантий (см. [LICENSE](LICENSE)). Авторы не аффилированы с какими-либо
платформами и сервисами, не предоставляют юридических консультаций и не призывают к нарушению
законов. Ответственность за соблюдение законодательства вашей юрисдикции — включая, где
применимо, ограничения на использование и популяризацию средств обхода блокировок — лежит
исключительно на вас. Не используйте это программное обеспечение в незаконных целях и во вред
другим. Авторы не несут ответственности за любое использование третьими лицами.

## Лицензия

MIT — см. [LICENSE](LICENSE).

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

Ключи детерминированно выводятся из PSK (`mgt-sig:` / `mgt-salt:` / `mgt-box:`), поэтому
никаких доменов, сертификатов, трекеров и брокеров не нужно. Данные — secretbox-фреймы с
per-connection ключами.

## Быстрый старт

**Exit (VPS с публичным IPv4):**
```bash
npm install
MAGNETGATE_SEQ_FILE=/var/lib/magnetgate/seq node src/exit.js "<psk>" 49001 <PUBLIC_IP>
```
(продакшн — systemd-юниты в `systemd/`)

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
| `DHT_BOOTSTRAP` | CSV bootstrap-нод; по умолчанию публичные. Рекомендуется свой узел на VPS |
| `MAGNETGATE_SEQ_FILE` | персистентность `seq` (обязательно на exit: рестарты должны инкрементировать) |
| `MAGNETGATE_RULES` | файл правил split-tunnel |

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

## Деплой (pull-based автодеплой)

Сервер сам подтягивает `main` с GitHub (без GitHub Actions и лишних портов):

```bash
# корень репозитория == /opt/magnetgate
git init && git remote add origin https://github.com/danifest751/magnetgate.git
git fetch origin && git checkout -f main origin/main
cp systemd/*.service systemd/*.timer /etc/systemd/system/
systemctl daemon-reload && systemctl enable --now magnetgate-exit magnetgate-dht magnetgate-deploy.timer
```

`magnetgate-deploy.timer` каждые 3 минуты запускает `scripts/deploy.sh`: fetch → hard reset на
`origin/main` → `npm install` (только если изменился lockfile) → копирование изменённых
systemd-юнитов → рестарт сервисов. Репо публичное — pull без ключей; если станет приватным,
добавьте read-only deploy key. Ручной запуск: `systemctl start magnetgate-deploy`.

## Документация

Дизайн-заметки, ТЗ, методика испытаний и общий ресёрч лежат во внутренней папке `docs/`, которая
намеренно не публикуется в репозитории. Отслеживаемый отчёт об испытаниях:
[tests/results.md](tests/results.md). Правила коммитов: [CONTRIBUTING.md](CONTRIBUTING.md)
(Conventional Commits, только английский, проверяется хуком `commit-msg`).

## Статус и ограничения

M1–M5 выполнены и испытаны (см. `tests/results.md`). Дальше: uTP/KCP дата-план,
мультипатчинг нескольких exit'ов, сервис-изация клиента.

Важно: PoC-уровень обфускации — дата-канал маскируется под BitTorrent-семейство лишь частично;
провайдер сервиса (DHT) видит IP-адреса участников put/get как обычный BT-узел. Используйте на
свою ответственность и в рамках законов вашей юрисдикции.

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

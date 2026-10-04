# Namron Zigbee Edge thermostat - huskeliste

Status per 2026-10-01, repo-kode `603de99` (branch `claude/trusting-meitner-ga1p5l`), fastvare 1.14.

## Huskeliste

1. **Temperatur ved ferie (vacation)**
   - `holiday_temp_set` (0x8013, °C x100) finnes og leses riktig (19 °C ble brukt da ferie ble slått på).
   - Ikke testet: å *skrive* `holiday_temp_set` / `holiday_temp_set_f` fra Z2M, og om panelet viser ny verdi.
2. **Hysterese**
   - Ikke tilgjengelig over Zigbee på fastvare 1.12/1.14 (discover slutter på 0x8029, ingen
     produsentspesifikke attributter, 0x8045 og Homey sin 0x100A gir UNSUPPORTED_ATTRIBUTE,
     endring på panelet endrer ingen attributt).
   - Videre: spørre Namron om fastvare som eksponerer hysterese (f.eks. 0x8045 som på Simplify),
     og sjekke nye fastvareversjoner med discover når de kommer.

3b. **Kun på panelet (ikke over Zigbee):** Equipment (electric/water), Idle backlight, hysterese, Intelligence. Regulator cycle. Sensor mode endret på panelet rapporteres, unntatt modus uten tilkoblet føler.
    Equipment testet 2026-10-04: ingen rapport, ctrlSeqeOfOper (4) og 0x801c (0) uendret.
3c. **0x8014-0x801a:** tomme tekstfelt på begge termostatene. Les 32788-32791 etter en endring på panelet.

## Bør sjekkes

3. `max_heat_temp` / `max_heat_temp_f` (0x8025/0x8026): skriv og se om panelet følger.
5. `fault` (0x8006): bit 5 = External Sensor Error (bekreftet). Andre bits ukjent (vises som er0-er7).
6. `window_state` (0x8002): åpent vindu-deteksjon i praksis.
7. Klokke ved sommertid -> vintertid (25.10.2026): stemmer klokka på panelet etterpå med `auto_time` på?

## Ferdig og bekreftet på termostaten

- `countdown_left` (0x8024): rapporteres ved start, endring og stopp
- Strøm/effekt/energi (`power`, `current`, `energy`)
- Samme testrunde på TermoTest (fastvare 1.12)
- OTA: ingen fastvare på Z2M sin OTA-side; termostatene er oppdatert manuelt
- `fault`: bit 5 = External Sensor Error
- Regulator: `regulator_percentage` virker (50 % = 90 s på / 90 s av). `regulator_cycle` (0x8007) henger ikke sammen med syklusen på panelet (1-30 min): skriving endrer ikke panel/regulering, endring på panelet rapporteres ikke (fw 1.12 og 1.14)
- `holiday_temp_set`: skriving bekreftet av termostaten; °C og °F lagres separat (begge skrives nå)
- °F-display: klimakortet følger setpunkt og temperatur (0x8011/0x8012)
- Feriedatoer som dager siden 1970 (10957 = ikke satt)


System mode, setpoint/schedule/eco, sensor mode, regulator %, regulator cycle, frost, window open check,
panel brightness, screen on time, °C/°F, klokkesynk, av/på, kalibrering ±10, countdown + countdown_left,
tastelås (lock1/unlock), week_program (0x8003), week_program_schedule (0xE002, også i °F), vacation med datoer.

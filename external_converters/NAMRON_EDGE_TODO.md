# Namron Zigbee Edge thermostat - huskeliste

Status per 2026-10-04, repo-kode `3abb154` (branch `claude/trusting-meitner-ga1p5l`).
Testet på Stue Gulvvarme (fastvare 1.14) og TermoTest (fastvare 1.12).

## Gjenstår å sjekke

1. **`window_state` (0x8002):** åpent vindu-deteksjon i praksis.
2. **Klokke ved overgang til vintertid (25.10.2026):** stemmer klokka på panelet etterpå med `auto_time` på?
3. **`fault` (0x8006):** bare bit 5 er kjent. Andre biter vises som er0-er7 og navngis når de dukker opp.
4. **0x8014-0x801a:** tomme tekstfelt på begge termostatene. Les 32788-32791 etter en endring på panelet.
5. **Ferie- eller makstemperatur endret på panelet i °F-modus:** oppdateres °C-verdien som Z2M leser?

## Ikke tilgjengelig over Zigbee (settes bare på panelet)

- **Hysterese:** discover slutter på 0x8029, ingen produsentspesifikke attributter, 0x8045 og 0x100A gir
  UNSUPPORTED_ATTRIBUTE, og endring på panelet endrer ingen attributt. 0x8003 er ukesprogrammet, ikke hysterese.
- **Intelligence, Equipment (electric/water), Idle backlight:** ingen rapport og ingen endrede attributter.
- **Regulator cycle (1-30 min):** 0x8007 henger ikke sammen med syklusen termostaten bruker. Skriving endrer
  ikke panel eller regulering, og endring på panelet rapporteres ikke.
- **Videre:** spør Namron om fastvare som eksponerer hysterese (f.eks. 0x8045 som på Simplify), og kjør
  discover på nytt når ny fastvare kommer.

## Ferdig og bekreftet på termostatene

- System mode, setpoint/schedule/eco, av/på, kalibrering ±10, frost, window open check
- Sensor mode fra Z2M (modus uten tilkoblet føler avvises). Endring på panelet rapporteres,
  unntatt modus uten tilkoblet føler
- `fault`: bit 5 = External Sensor Error
- Regulator: `regulator_percentage` virker (50 % = like lang tid på og av)
- `panel_brightness` = Active backlight, `screen_on_time`
- °C/°F-display: klimakortet følger setpunkt og temperatur også i °F-modus (0x8011/0x8012)
- `holiday_temp_set` og `max_heat_temp`: °C og °F skrives sammen (32 °C vises som 90 °F, 15 °C som 59 °F)
- Vacation med datoer (dager siden 1970, 10957 = ikke satt)
- Countdown og `countdown_left`
- Tastelås (lock1/unlock)
- Klokkesynk (Unix lokal tid)
- `week_program` (0x8003) og `week_program_schedule` (0xE002, også i °F)
- Strøm, effekt og energi
- Alle verdier leses ved oppstart (i grupper på 8)
- OTA: ingen fastvare på Z2M sin OTA-side, termostatene er oppdatert manuelt

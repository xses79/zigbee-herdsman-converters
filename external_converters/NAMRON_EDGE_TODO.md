# Namron Zigbee Edge thermostat - huskeliste

Status per 2026-10-04, repo-kode `9da7de8` (branch `claude/trusting-meitner-ga1p5l`).

| Termostat | Zigbee (swBuildId / dateCode / OTA) | MCU (Simplify-appen) |
| --- | --- | --- |
| Stue Gulvvarme (0x64028ffffeb84671) | 1.14 / 20260421 | ikke sjekket |
| TermoTest (0x70d07efffea64529) | 1.14 / 20260415 / OTA 40 (fra 1.12 / 20241017 / OTA 36, oppdatert via Z2M med Homey-filen) | 1.1.3 (fra 1.1.2, via appen over Bluetooth) |

Det meste er først testet på 1.12 (TermoTest) og 1.14 (Stue). Deep scan etter oppdateringene av TermoTest
(MCU 1.1.3, så Zigbee 1.14) ga samme attributter og kommandoer som før.

## Gjenstår å sjekke

1. **Klokke ved overgang til vintertid (25.10.2026):** stemmer klokka på panelet etterpå med `auto_time` på?
2. **`fault` (0x8006):** bare bit 5 er kjent. Andre biter vises som er0-er7 og navngis når de dukker opp.
3. **0x8014-0x801a:** tomme tekstfelt på begge termostatene og ikke brukt av noen kjent integrasjon. Uendret etter 1.14 / MCU 1.1.3. Sjekkes ved ny fastvare.
4. **0x801c («regulationMode») og 0x801e («summerWinterSwitch»):** alltid 0, også i cool med Equipment = Water, med Auto Daylight Saving på og etter oppdatering til 1.14 / MCU 1.1.3.
5. **Ferie- eller makstemperatur endret på panelet i °F-modus:** oppdateres °C-verdien som Z2M leser?

## Fastvare og versjoner

- MCU-versjonen kan ikke leses over Zigbee, bare i Simplify-appen (Bluetooth). 0x8052 Mcu_version gir UNSUPPORTED_ATTRIBUTE.
- genBasic 0x000e = «02_00000» på begge og uendret etter MCU-oppdatering, så det er ikke MCU-versjonen.
- applicationVersion, stackVersion og hwVersion er 0, og productCode og productURL er tomme.
- OTA-filen T11_ZG_Multiprotocol_1.14_FW40.ota (Homey-pakken) er Zigbee-delen (EBL, mfr 0x126A, imageType 0x03F1, versjon 40), ikke MCU.
- Ingen fastvare på Z2M sin OTA-side.

## Ikke tilgjengelig over Zigbee (settes bare på panelet)

- **Hysterese:** discover slutter på 0x8029, ingen produsentspesifikke attributter, 0x8045 og 0x100A gir
  UNSUPPORTED_ATTRIBUTE, og endring på panelet endrer ingen attributt. 0x8003 er ukesprogrammet, ikke hysterese.
- **Standard ZCL ukesprogram:** discover oppgir set/get/clearWeeklySchedule (0x01-0x03) på hvacThermostat, men
  getWeeklySchedule gir UNSUPPORTED_COMMAND (0x81), også med alle dager og begge modi (TermoTest, 2026-10-04).
  Ukesprogrammet kan bare leses via 0xE002-meldingen og bare endres på panelet.
- **Auto Daylight Saving** (vises når Auto Sync Time er Off): ingen rapport, 0x801e uendret.
- **Normally Open/Closed** (ventil ved Water): ingen rapport.
- **Intelligence, Equipment (electric/water), Idle backlight:** ingen rapport og ingen endrede attributter.
  Equipment styrer om kjøling er lov: med Electric går `system_mode` cool rett tilbake til heat, med Water blir den stående (TermoTest).
- **Regulator cycle (1-30 min):** settes bare på panelet. 0x8007 er Zigbee-modulens egen kopi: skriving godtas men når
  aldri panel/regulering (prøvd direkte, les-før-skriv, les-skriv-les og sammen med sensorMode som Homey gjør).
  Endring på panelet oppdaterer kopien bare noen ganger (lest 17 og 4 riktig, men 2 mens panelet viste 8).
  I Z2M bare lesing.
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
- `window_state`: åpent vindu oppdaget og rapportert (TermoTest ute, fall på ~1 °C/min mens den varmet)
- Tastelås (lock1/unlock)
- Klokkesynk (Unix lokal tid). Auto Sync Time endret på panelet rapporteres, og Z2M synker klokka automatisk
- `week_program` (0x8003) og `week_program_schedule` (0xE002, også i °F)
- Strøm, effekt og energi
- Alle verdier leses ved oppstart (i grupper på 8)
- OTA: ingen fastvare på Z2M sin OTA-side, termostatene er oppdatert manuelt

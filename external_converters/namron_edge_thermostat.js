// Namron Zigbee Edge Thermostat - external converter
// Models: 4566702 / 4566703 / 4512783 / 4512784 (zigbeeModel T11_ZG)
//
// Built from src/devices/namron.ts on branch claude/trusting-meitner-ga1p5l
// (commit d7aca46), i.e. exactly what goes into the pull request, for use until
// a Zigbee2MQTT release includes it. No test tools, no debug logging.
// Contains no regex literals and no backslashes, so the Z2M converter editor can save it.
// Remove this file once your Z2M release contains the same changes.

const fz = require("zigbee-herdsman-converters/converters/fromZigbee");
const tz = require("zigbee-herdsman-converters/converters/toZigbee");
const exposes = require("zigbee-herdsman-converters/lib/exposes");
const m = require("zigbee-herdsman-converters/lib/modernExtend");
const reporting = require("zigbee-herdsman-converters/lib/reporting");

const e = exposes.presets;
const ea = exposes.access;

// Standard ZCL data type codes.
const DataType = {BOOLEAN: 0x10, BITMAP8: 0x18, UINT8: 0x20, UINT16: 0x21, UINT32: 0x23, INT8: 0x28, INT16: 0x29, ENUM8: 0x30};

// Degree sign without a backslash escape (the Z2M converter editor mangles escapes).
const DEG = String.fromCharCode(176);

// --- Namron Zigbee Edge Thermostat (4566702/4566703/4512783/4512784) ----------
// Clock (0x800b): Unix time (seconds since 1970) in *local* time. Seconds since 2000 are
// acknowledged but ignored by the device (it shows a 1996 date). The panel shows the value
// as-is, with no time zone of its own. Confirmed on a 4512783.
function edgeLocalTime() {
    const now = new Date();
    return Math.round(now.getTime() / 1000 - now.getTimezoneOffset() * 60);
}
function edgeDateDecode(value) {
    if (!value) return null;
    try {
        const s = String(value).padStart(6, "0");
        return `20${s.slice(0, 2)}-${s.slice(2, 4)}-${s.slice(4, 6)}`;
    } catch (_) {
        return null;
    }
}
function edgeDateEncode(value) {
    // Plain string parsing (no regex): the Z2M converter editor mangles regex literals.
    const parts = String(value).split("-");
    const ok = parts.length === 3 && parts[0].length === 4 && parts[0].startsWith("20") && parts[1].length === 2 && parts[2].length === 2;
    const digits = ok ? parts[0].slice(2) + parts[1] + parts[2] : "";
    if (!ok || Number.isNaN(Number(digits)) || digits.includes(" ")) {
        throw new Error(`Invalid date: ${value}. Use YYYY-MM-DD format, e.g. 2026-06-05.`);
    }
    return Number(digits);
}
function deriveEdgeThermostatMode(frost, vacationMode, sensorMode, progOpMode, countdownSet) {
    if (frost === "ON") return "frost";
    if (vacationMode === "ON") return "holiday";
    if (sensorMode === "regulator") return "regulator";
    if (countdownSet > 0) return "countdown";
    if (progOpMode === "schedule") return "schedule";
    if (progOpMode === "eco") return "eco";
    return "manual";
}
const edgeSensorModeLookup = {
    0: "air",
    1: "floor",
    2: "air_floor",
    3: "external",
    4: "external_floor",
    5: "floor_percent",
    6: "regulator",
};
const edgeSensorModeValueLookup = {
    air: 0,
    floor: 1,
    air_floor: 2,
    external: 3,
    external_floor: 4,
    floor_percent: 5,
    regulator: 6,
};
const edgeOnOffLookup = {OFF: 0, ON: 1};
// Week program (0x8003), mapped on real hardware by changing it on the device.
// Names follow the device's own labels: "no time off" = every day a work day, "time off" = every day off.
const edgeWeekProgramLookup = {0: "mon_fri_sat_sun", 1: "mon_sat_sun", 2: "no_time_off", 3: "time_off"};
const edgeOnOffReverseLookup = {0: "OFF", 1: "ON"};
// id 2/3 confirmed against real hardware (Namron's own Homey driver agrees).
const edgeScreenOnTimeLookup = {0: "always_on", 1: "10s", 2: "30s", 3: "60s"};
const edgeScreenOnTimeValueLookup = {always_on: 0, "10s": 1, "30s": 2, "60s": 3};
// Minimal command-only custom cluster registration, needed so entity.command()
// can send the device's two custom commands (setEco 0x08, setProgram 0x07).
// Deliberately registers NO attributes - a full attribute registration on
// this cluster was confirmed to break the device's cluster-name dispatch
// entirely (see the module-level comment above); a commands-only
// registration carries none of that risk and was confirmed safe on real
// hardware.
function edgeThermostatCommands() {
    return m.deviceAddCustomCluster("hvacThermostat", {
        ID: 0x0201,
        name: "hvacThermostat",
        attributes: {},
        commands: {
            setProgram: {ID: 0x07, name: "setProgram", parameters: [{name: "runMode", type: DataType.BOOLEAN}]},
            setEco: {ID: 0x08, name: "setEco", parameters: [{name: "ecoMode", type: DataType.BOOLEAN}]},
        },
        commandsResponse: {},
    });
}
async function safeReadEdge(endpoint, cluster, attrs) {
    try {
        await endpoint.read(cluster, attrs);
    } catch (_) {}
}
async function writeEdgeHvac(entity, attr, value, type) {
    // Confirmed via testing: this firmware rejects several of these writes
    // with NOT_AUTHORIZED unless a default response is requested, so unlike
    // most modern converters we do NOT pass disableDefaultResponse: true here.
    await entity.write("hvacThermostat", {[attr]: {value, type}}, {disableDefaultResponse: false});
}
async function readThenWriteEdgeHvac(entity, attr, value, type) {
    // Some attributes (frost, window_open_check, vacation_mode, the time-sync
    // value) were confirmed to need a prior read in the same session before
    // a write is accepted - a known quirk of this HZC-platform firmware.
    try {
        await entity.read("hvacThermostat", [attr]);
    } catch (_) {}
    await writeEdgeHvac(entity, attr, value, type);
}
async function writeThenReadEdgeHvac(entity, attr, value, type, readAttrs) {
    // The device has a separate MCU driving the LCD. Attributes that change
    // what's drawn on screen are confirmed-then-read-back after a short delay
    // so the reported state matches what the screen actually settles on.
    await readThenWriteEdgeHvac(entity, attr, value, type);
    await new Promise((resolve) => setTimeout(resolve, 1000));
    try {
        await entity.read("hvacThermostat", readAttrs);
    } catch (_) {}
}
// programingOperMode is a bitmap on this device: bit 0 = schedule, bit 2 = eco. It reports 5 (schedule + eco),
// which fz.thermostat's lookup (0, 1, 3, 4) rejects with an exception that also drops the rest of the message.
function edgeProgrammingOperationMode(value) {
    if (value & 0x04) return "eco";
    if (value & 0x01) return "schedule";
    return "setpoint";
}
const fzEdge = {
    thermostat: {
        cluster: "hvacThermostat",
        type: ["attributeReport", "readResponse"],
        convert: (model, msg, publish, options, meta) => {
            const {programingOperMode, ...rest} = msg.data;
            const result = Object.keys(rest).length > 0 ? (fz.thermostat.convert(model, {...msg, data: rest}, publish, options, meta) ?? {}) : {};
            if (programingOperMode !== undefined) {
                result.programming_operation_mode = edgeProgrammingOperationMode(programingOperMode);
            }
            return result;
        },
    },
    basic: {
        cluster: "genBasic",
        type: ["attributeReport", "readResponse"],
        convert: (model, msg) => {
            const result = {};
            if (msg.data["swBuildId"] !== undefined) result["firmware_version"] = msg.data["swBuildId"];
            if (msg.data["dateCode"] !== undefined) result["firmware_date"] = msg.data["dateCode"];
            return result;
        },
    },
    edge_custom: {
        cluster: "hvacThermostat",
        type: ["attributeReport", "readResponse"],
        convert: (model, msg, publish, options, meta) => {
            const result = {};
            for (const [key, value] of Object.entries(msg.data)) {
                switch (Number(key)) {
                    case 0x8000:
                        result["window_open_check"] = edgeOnOffReverseLookup[String(value)] ?? String(value);
                        break;
                    case 0x8001:
                        result["frost"] = edgeOnOffReverseLookup[String(value)] ?? String(value);
                        break;
                    case 0x8002:
                        result["window_state"] = value ? "open" : "closed";
                        break;
                    case 0x8003:
                        result["week_program"] = edgeWeekProgramLookup[String(value)] ?? String(value);
                        break;
                    case 0x8004:
                        result["sensor_mode"] = edgeSensorModeLookup[String(value)] ?? String(value);
                        break;
                    case 0x8005:
                        result["panel_brightness"] = value;
                        break;
                    case 0x8006: {
                        const bits = typeof value?.getBits === "function" ? value.getBits() : [];
                        result["fault"] = bits.length ? bits.join(",") : "none";
                        break;
                    }
                    case 0x8007:
                        result["regulator_cycle"] = value;
                        break;
                    case 0x800a:
                        result["auto_time_sync_pending"] = edgeOnOffReverseLookup[String(value)] ?? String(value);
                        if (value === 1) {
                            writeEdgeHvac(msg.endpoint, 0x800b, edgeLocalTime(), DataType.UINT32)
                                .then(() => writeEdgeHvac(msg.endpoint, 0x800a, 0, DataType.BOOLEAN))
                                .then(() => msg.endpoint.read("hvacThermostat", [0x800b]))
                                .catch(() => {});
                        }
                        break;
                    case 0x800b:
                        try {
                            // Local wall-clock time stored as Unix seconds, so format it without a time zone.
                            result["clock_last_synced"] = new Date(value * 1000).toISOString().replace("T", " ").slice(0, 19);
                        } catch (_) {
                            result["clock_last_synced"] = String(value);
                        }
                        break;
                    case 0x800c:
                        result["min_heat_setpoint_limit_f"] = value / 100;
                        break;
                    case 0x800d:
                        result["max_heat_setpoint_limit_f"] = value / 100;
                        break;
                    case 0x800e:
                        result["min_cool_setpoint_limit_f"] = value / 100;
                        break;
                    case 0x800f:
                        result["max_cool_setpoint_limit_f"] = value / 100;
                        break;
                    case 0x8010:
                        result["occupied_cooling_setpoint_f"] = value / 100;
                        break;
                    case 0x8011:
                        result["occupied_heating_setpoint_f"] = value / 100;
                        break;
                    case 0x8012:
                        result["local_temperature_f"] = value / 100;
                        break;
                    case 0x8013:
                        result["holiday_temp_set"] = value / 100;
                        break;
                    case 0x801b:
                        result["holiday_temp_set_f"] = value / 100;
                        break;
                    case 0x801d:
                        result["regulator_percentage"] = value;
                        break;
                    case 0x801f:
                        result["vacation_mode"] = edgeOnOffReverseLookup[String(value)] ?? String(value);
                        break;
                    case 0x8020:
                        result["vacation_start"] = edgeDateDecode(value);
                        break;
                    case 0x8021:
                        result["vacation_end"] = edgeDateDecode(value);
                        break;
                    case 0x8022:
                        result["auto_time"] = edgeOnOffReverseLookup[String(value)] ?? String(value);
                        break;
                    case 0x8023:
                        // 5-minute steps (0-24 -> 0-120 min), confirmed against real hardware.
                        result["countdown_set"] = value * 5;
                        break;
                    case 0x8025:
                        result["max_heat_temp"] = value / 10;
                        break;
                    case 0x8026:
                        result["max_heat_temp_f"] = value / 10;
                        break;
                    case 0x8027:
                        result["min_cool_temp"] = value / 10;
                        break;
                    case 0x8028:
                        result["min_cool_temp_f"] = value / 10;
                        break;
                    case 0x8029:
                        result["screen_on_time"] = edgeScreenOnTimeLookup[String(value)] ?? String(value);
                        break;
                }
            }
            const merged = Object.assign({}, meta?.state ?? {}, result);
            // fzEdge.thermostat parses programingOperMode from the same message, but its result is not in meta.state yet.
            if (msg.data.programingOperMode !== undefined) {
                merged.programming_operation_mode = edgeProgrammingOperationMode(msg.data.programingOperMode);
            }
            result["thermostat_mode"] = deriveEdgeThermostatMode(
                merged["frost"],
                merged["vacation_mode"],
                merged["sensor_mode"],
                merged["programming_operation_mode"],
                merged["countdown_set"] ?? 0,
            );
            return result;
        },
    },
};
const tzEdge = {
    // Setting the mode uses the device's own custom commands (0x07/0x08)
    // rather than writing the programingOperMode bitmap directly - writing 0
    // to return to manual ("setpoint") mode was confirmed to be silently
    // ignored by this firmware. Sent via entity.command() using the
    // commands-only custom cluster registration below (edgeThermostatCommands).
    programming_operation_mode: {
        key: ["programming_operation_mode"],
        convertSet: async (entity, key, value) => {
            const clearVacationMode = async () => {
                try {
                    await readThenWriteEdgeHvac(entity, 0x801f, 0, DataType.BOOLEAN);
                } catch (_) {
                    /* non-fatal courtesy side-effect */
                }
            };
            if (value === "eco") {
                await clearVacationMode();
                await entity.command("hvacThermostat", "setEco", {ecoMode: true}, {disableDefaultResponse: false});
            } else {
                await entity.command("hvacThermostat", "setEco", {ecoMode: false}, {disableDefaultResponse: false});
                await clearVacationMode();
                await entity.command("hvacThermostat", "setProgram", {runMode: value === "schedule"}, {disableDefaultResponse: false});
            }
            return {state: {programming_operation_mode: value}};
        },
        convertGet: async (entity) => {
            await entity.read("hvacThermostat", ["programingOperMode"]);
        },
    },
    system_mode: {
        key: ["system_mode"],
        convertSet: (entity, key, value, meta) => {
            if (value === "cool" && meta.state?.["sensor_mode"] === "regulator") {
                throw new Error("Cannot switch to cooling while in regulator mode");
            }
            return tz.thermostat_system_mode.convertSet(entity, key, value, meta);
        },
        convertGet: async (entity, key, meta) => tz.thermostat_system_mode.convertGet(entity, key, meta),
    },
    sensor_mode: {
        key: ["sensor_mode"],
        convertSet: async (entity, key, value, meta) => {
            const raw = edgeSensorModeValueLookup[value];
            if (raw === undefined) throw new Error(`Invalid sensor_mode: ${value}`);
            if (value === "regulator" && meta.state?.["system_mode"] === "cool") {
                throw new Error("Cannot switch to regulator mode while in cooling mode");
            }
            await writeThenReadEdgeHvac(entity, 0x8004, raw, DataType.ENUM8, [0x8004, 0x801d, 0x8007]);
            return {state: {sensor_mode: value}};
        },
        convertGet: async (entity) => {
            await entity.read("hvacThermostat", [0x8004]);
        },
    },
    frost: {
        key: ["frost"],
        convertSet: async (entity, key, value) => {
            await readThenWriteEdgeHvac(entity, 0x8001, value === "ON" ? 1 : 0, DataType.BOOLEAN);
            return {state: {frost: value}};
        },
        convertGet: async (entity) => {
            await entity.read("hvacThermostat", [0x8001]);
        },
    },
    window_open_check: {
        key: ["window_open_check"],
        convertSet: async (entity, key, value) => {
            const raw = edgeOnOffLookup[value];
            if (raw === undefined) throw new Error(`Invalid window_open_check: ${value}`);
            await readThenWriteEdgeHvac(entity, 0x8000, raw, DataType.BOOLEAN);
            return {state: {window_open_check: value}};
        },
        convertGet: async (entity) => {
            await entity.read("hvacThermostat", [0x8000]);
        },
    },
    vacation_mode: {
        key: ["vacation_mode"],
        convertSet: async (entity, key, value) => {
            const raw = edgeOnOffLookup[value];
            if (raw === undefined) throw new Error(`Invalid vacation_mode: ${value}`);
            await readThenWriteEdgeHvac(entity, 0x801f, raw, DataType.BOOLEAN);
            return {state: {vacation_mode: value}};
        },
        convertGet: async (entity) => {
            await entity.read("hvacThermostat", [0x801f]);
        },
    },
    vacation_start: {
        key: ["vacation_start"],
        convertSet: async (entity, key, value) => {
            const raw = edgeDateEncode(value);
            await readThenWriteEdgeHvac(entity, 0x8020, raw, DataType.UINT32);
            return {state: {vacation_start: value}};
        },
        convertGet: async (entity) => {
            await entity.read("hvacThermostat", [0x8020]);
        },
    },
    vacation_end: {
        key: ["vacation_end"],
        convertSet: async (entity, key, value) => {
            const raw = edgeDateEncode(value);
            await readThenWriteEdgeHvac(entity, 0x8021, raw, DataType.UINT32);
            return {state: {vacation_end: value}};
        },
        convertGet: async (entity) => {
            await entity.read("hvacThermostat", [0x8021]);
        },
    },
    auto_time: {
        key: ["auto_time"],
        convertSet: async (entity, key, value) => {
            const raw = edgeOnOffLookup[value];
            if (raw === undefined) throw new Error(`Invalid auto_time: ${value}`);
            await readThenWriteEdgeHvac(entity, 0x8022, raw, DataType.BOOLEAN);
            return {state: {auto_time: value}};
        },
        convertGet: async (entity) => {
            await entity.read("hvacThermostat", [0x8022]);
        },
    },
    sync_time: {
        key: ["sync_time"],
        convertSet: async (entity) => {
            await readThenWriteEdgeHvac(entity, 0x800b, edgeLocalTime(), DataType.UINT32);
            await readThenWriteEdgeHvac(entity, 0x800a, 0, DataType.BOOLEAN);
            try {
                await entity.read("hvacThermostat", [0x800b]);
            } catch (_) {}
            return {state: {sync_time: "sync"}};
        },
        convertGet: async (entity) => {
            await entity.read("hvacThermostat", [0x800a, 0x800b]);
        },
    },
    countdown_set: {
        key: ["countdown_set"],
        convertSet: async (entity, key, value, meta) => {
            const minutes = Number(value);
            if (Number.isNaN(minutes) || minutes < 0 || minutes > 120 || minutes % 5 !== 0) {
                throw new Error("countdown_set must be a multiple of 5, between 0 and 120 (minutes)");
            }
            if (meta.state?.["system_mode"] === "cool") {
                throw new Error("Cannot set the countdown timer while in cooling mode");
            }
            // 5-minute steps (raw 8 = 40 min), confirmed on real hardware.
            await readThenWriteEdgeHvac(entity, 0x8023, minutes / 5, DataType.ENUM8);
            return {state: {countdown_set: minutes}};
        },
        convertGet: async (entity) => {
            await entity.read("hvacThermostat", [0x8023]);
        },
    },
    // Week program (0x8003) is read-only: changes made on the device read back, but the device is not
    // confirmed to act on writes, and it does not report changes, so it is polled.
    week_program: {
        key: ["week_program"],
        convertGet: async (entity) => {
            await entity.read("hvacThermostat", [0x8003]);
        },
    },
    // countdownLeft (0x8024) is not exposed: this firmware answers reads on it with a
    // meaningless value (1325465600), confirmed on real hardware.
    //
    // Hysteresis is not exposed: it is not reachable over Zigbee (checked on firmware 1.12 and 1.14).
    // Both firmwares answer UNSUPPORTED_ATTRIBUTE for 0x8035, 0x8041, 0x8045 and 0x8052 (1.14 also
    // for 0x802a-0x8040), and changing hysteresis on the device changes no readable attribute.
    // 0x8003 is not hysteresis but the week program setting (week_program above). The "Intelligence"
    // on/off setting is not reachable over Zigbee either.
    screen_on_time: {
        key: ["screen_on_time"],
        convertSet: async (entity, key, value) => {
            const raw = edgeScreenOnTimeValueLookup[value];
            if (raw === undefined) throw new Error(`Invalid screen_on_time: ${value}`);
            await writeThenReadEdgeHvac(entity, 0x8029, raw, DataType.ENUM8, [0x8029]);
            return {state: {screen_on_time: value}};
        },
        convertGet: async (entity) => {
            await entity.read("hvacThermostat", [0x8029]);
        },
    },
    panel_brightness: {
        key: ["panel_brightness"],
        convertSet: async (entity, key, value) => {
            const num = Math.round(Number(value));
            if (Number.isNaN(num) || num < 1 || num > 100) throw new Error("panel_brightness must be 1-100 (%)");
            await writeThenReadEdgeHvac(entity, 0x8005, num, DataType.UINT8, [0x8005]);
            return {state: {panel_brightness: num}};
        },
        convertGet: async (entity) => {
            await entity.read("hvacThermostat", [0x8005]);
        },
    },
    regulator_percentage: {
        key: ["regulator_percentage"],
        convertSet: async (entity, key, value) => {
            const num = Math.round(Number(value));
            if (Number.isNaN(num) || num < 0 || num > 100) throw new Error("regulator_percentage must be 0-100");
            await writeEdgeHvac(entity, 0x801d, num, DataType.INT16);
            return {state: {regulator_percentage: num}};
        },
        convertGet: async (entity) => {
            await entity.read("hvacThermostat", [0x801d]);
        },
    },
    regulator_cycle: {
        key: ["regulator_cycle"],
        convertSet: async (entity, key, value) => {
            const num = Math.round(Number(value));
            if (Number.isNaN(num) || num < 0 || num > 30) throw new Error("regulator_cycle must be 0-30");
            await writeEdgeHvac(entity, 0x8007, num, DataType.UINT8);
            return {state: {regulator_cycle: num}};
        },
        convertGet: async (entity) => {
            await entity.read("hvacThermostat", [0x8007]);
        },
    },
    holiday_temp_set: {
        key: ["holiday_temp_set"],
        convertSet: async (entity, key, value) => {
            const num = Number(value);
            if (Number.isNaN(num) || num < 5 || num > 40) throw new Error("holiday_temp_set must be 5-40");
            await writeEdgeHvac(entity, 0x8013, Math.round(num * 100), DataType.INT16);
            return {state: {holiday_temp_set: num}};
        },
        convertGet: async (entity) => {
            await entity.read("hvacThermostat", [0x8013]);
        },
    },
    holiday_temp_set_f: {
        key: ["holiday_temp_set_f"],
        convertSet: async (entity, key, value) => {
            const num = Number(value);
            if (Number.isNaN(num) || num < 41 || num > 104) throw new Error("holiday_temp_set_f must be 41-104");
            await writeEdgeHvac(entity, 0x801b, Math.round(num * 100), DataType.INT16);
            return {state: {holiday_temp_set_f: num}};
        },
        convertGet: async (entity) => {
            await entity.read("hvacThermostat", [0x801b]);
        },
    },
    max_heat_temp: {
        key: ["max_heat_temp"],
        convertSet: async (entity, key, value) => {
            const num = Number(value);
            if (Number.isNaN(num) || num < 15 || num > 35) throw new Error("max_heat_temp must be 15-35");
            await writeEdgeHvac(entity, 0x8025, Math.round(num * 10), DataType.INT16);
            return {state: {max_heat_temp: num}};
        },
        convertGet: async (entity) => {
            await entity.read("hvacThermostat", [0x8025]);
        },
    },
    max_heat_temp_f: {
        key: ["max_heat_temp_f"],
        convertSet: async (entity, key, value) => {
            const num = Number(value);
            if (Number.isNaN(num) || num < 59 || num > 95) throw new Error("max_heat_temp_f must be 59-95");
            await writeEdgeHvac(entity, 0x8026, Math.round(num * 10), DataType.INT16);
            return {state: {max_heat_temp_f: num}};
        },
        convertGet: async (entity) => {
            await entity.read("hvacThermostat", [0x8026]);
        },
    },
    min_cool_temp: {
        key: ["min_cool_temp"],
        convertSet: async (entity, key, value) => {
            const num = Number(value);
            if (Number.isNaN(num) || num < 10 || num > 30) throw new Error("min_cool_temp must be 10-30");
            await writeEdgeHvac(entity, 0x8027, Math.round(num * 10), DataType.INT16);
            return {state: {min_cool_temp: num}};
        },
        convertGet: async (entity) => {
            await entity.read("hvacThermostat", [0x8027]);
        },
    },
    min_cool_temp_f: {
        key: ["min_cool_temp_f"],
        convertSet: async (entity, key, value) => {
            const num = Number(value);
            if (Number.isNaN(num) || num < 50 || num > 86) throw new Error("min_cool_temp_f must be 50-86");
            await writeEdgeHvac(entity, 0x8028, Math.round(num * 10), DataType.INT16);
            return {state: {min_cool_temp_f: num}};
        },
        convertGet: async (entity) => {
            await entity.read("hvacThermostat", [0x8028]);
        },
    },
};
// --- Namron Zigbee Edge Thermostat END ---------------------------------------

const definition = {
    zigbeeModel: ["4566702", "4566703", "4512783", "4512784"],
    model: "4566702",
    vendor: "Namron",
    description: "Zigbee Edge Thermostat (external converter, repo d7aca46)",
    ota: true,
    extend: [
        edgeThermostatCommands(),
        // The device accepts a calibration of -10 to +10 deg C (confirmed on the device), wider than the ZCL default of +/-2.5 deg C.
        // Same as m.customLocalTemperatureCalibrationRange({min: -10, max: 10}) in the repo, inlined so this
        // file also works on Z2M versions that do not have that helper yet.
        m.deviceAddCustomCluster("hvacThermostat", {
            ID: 0x0201,
            name: "hvacThermostat",
            attributes: {
                localTemperatureCalibration: {
                    name: "localTemperatureCalibration",
                    ID: 0x0010,
                    type: DataType.INT8,
                    write: true,
                    min: -100,
                    max: 100,
                    default: 0,
                },
            },
            commands: {},
            commandsResponse: {},
        }),
        // The week program changed on the device is not reported, so read it periodically.
        m.poll({
            key: "namron_edge_week_program_poll",
            optionKey: "week_program_poll_interval",
            option: e
                .numeric("week_program_poll_interval", ea.SET)
                .withValueMin(-1)
                .withDescription("How often week_program is read from the device, in seconds (default: 900, -1 to disable)."),
            defaultIntervalSeconds: 900,
            poll: async (device) => {
                const endpoint = device.getEndpoint(1);
                if (!endpoint) return;
                await endpoint.read("hvacThermostat", [0x8003]);
            },
        }),
        m.onOff({powerOnBehavior: false}),
        m.humidity(),
        m.electricityMeter({voltage: false, configureReporting: false}),
    ],
    fromZigbee: [fzEdge.basic, fzEdge.thermostat, fzEdge.edge_custom, fz.hvac_user_interface],
    toZigbee: [
        tzEdge.system_mode,
        tz.thermostat_occupied_heating_setpoint,
        tz.thermostat_occupied_cooling_setpoint,
        tz.thermostat_local_temperature_calibration,
        tz.thermostat_temperature_display_mode,
        tz.thermostat_keypad_lockout,
        tzEdge.programming_operation_mode,
        tzEdge.sensor_mode,
        tzEdge.frost,
        tzEdge.window_open_check,
        tzEdge.vacation_mode,
        tzEdge.vacation_start,
        tzEdge.vacation_end,
        tzEdge.auto_time,
        tzEdge.sync_time,
        tzEdge.countdown_set,
        tzEdge.week_program,
        tzEdge.screen_on_time,
        tzEdge.panel_brightness,
        tzEdge.regulator_percentage,
        tzEdge.regulator_cycle,
        tzEdge.holiday_temp_set,
        tzEdge.holiday_temp_set_f,
        tzEdge.max_heat_temp,
        tzEdge.max_heat_temp_f,
        tzEdge.min_cool_temp,
        tzEdge.min_cool_temp_f,
    ],
    configure: async (device, coordinatorEndpoint) => {
        // Defensive re-registration - onEvent('start') (used by
        // edgeThermostatCommands' own registration) only fires at
        // process startup, so an already-paired device needs this too.
        device.addCustomCluster("hvacThermostat", {
            ID: 0x0201,
            name: "hvacThermostat",
            attributes: {},
            commands: {
                setProgram: {ID: 0x07, name: "setProgram", parameters: [{name: "runMode", type: DataType.BOOLEAN}]},
                setEco: {ID: 0x08, name: "setEco", parameters: [{name: "ecoMode", type: DataType.BOOLEAN}]},
            },
            commandsResponse: {},
        });
        const endpoint = device.getEndpoint(1);
        // Bind clusters individually - this firmware doesn't support
        // genOta binding, and one failing bind must never block the rest.
        for (const cluster of [
            "genOnOff",
            "genTime",
            "hvacThermostat",
            "hvacUserInterfaceCfg",
            "msRelativeHumidity",
            "seMetering",
            "haElectricalMeasurement",
        ]) {
            try {
                await endpoint.bind(cluster, coordinatorEndpoint);
            } catch (_) {}
        }
        try {
            await reporting.thermostatTemperature(endpoint, {min: 10, max: 300, change: 10});
        } catch (_) {}
        try {
            await reporting.thermostatOccupiedHeatingSetpoint(endpoint, {min: 10, max: 300, change: 50});
        } catch (_) {}
        try {
            await reporting.thermostatOccupiedCoolingSetpoint(endpoint, {min: 10, max: 300, change: 50});
        } catch (_) {}
        try {
            await reporting.humidity(endpoint, {min: 10, max: 300, change: 100});
        } catch (_) {}
        await safeReadEdge(endpoint, "genBasic", ["swBuildId", "dateCode"]);
        await safeReadEdge(endpoint, "hvacThermostat", ["localTemp"]);
        await safeReadEdge(endpoint, "hvacThermostat", ["occupiedHeatingSetpoint"]);
        await safeReadEdge(endpoint, "hvacThermostat", ["occupiedCoolingSetpoint"]);
        await safeReadEdge(endpoint, "hvacThermostat", ["systemMode"]);
        await safeReadEdge(endpoint, "hvacThermostat", ["runningState"]);
        await safeReadEdge(endpoint, "hvacThermostat", ["localTemperatureCalibration"]);
        await safeReadEdge(endpoint, "hvacThermostat", ["pIHeatingDemand"]);
        await safeReadEdge(endpoint, "hvacThermostat", ["programingOperMode"]);
        await safeReadEdge(endpoint, "hvacThermostat", ["absMinHeatSetpointLimit"]);
        await safeReadEdge(endpoint, "hvacThermostat", ["absMaxHeatSetpointLimit"]);
        await safeReadEdge(endpoint, "hvacThermostat", ["absMinCoolSetpointLimit"]);
        await safeReadEdge(endpoint, "hvacThermostat", ["absMaxCoolSetpointLimit"]);
        await safeReadEdge(
            endpoint,
            "hvacThermostat",
            [
                0x8000, 0x8001, 0x8002, 0x8003, 0x8004, 0x8005, 0x8006, 0x8007, 0x800a, 0x800b, 0x800c, 0x800d, 0x800e, 0x800f, 0x8010, 0x8011,
                0x8012, 0x8013, 0x801b, 0x801d, 0x801f, 0x8020, 0x8021, 0x8022, 0x8023, 0x8025, 0x8026, 0x8027, 0x8028, 0x8029,
            ],
        );
        await safeReadEdge(endpoint, "hvacUserInterfaceCfg", ["keypadLockout", "tempDisplayMode"]);
        await safeReadEdge(endpoint, "seMetering", ["currentSummDelivered", "divisor", "multiplier"]);
        await safeReadEdge(endpoint, "haElectricalMeasurement", ["activePower", "rmsCurrent", "acPowerMultiplier", "acPowerDivisor"]);
        device.powerSource = "Mains (single phase)";
        device.save();
    },
    exposes: [
        e
            .climate()
            .withLocalTemperature()
            .withSetpoint("occupied_heating_setpoint", 5, 35, 0.5)
            .withSystemMode(["off", "heat", "cool"])
            .withRunningState(["idle", "heat", "cool"])
            .withLocalTemperatureCalibration(-10, 10, 0.1)
            .withPiHeatingDemand(),
        // Kept separate from climate() (not chained via withSetpoint()):
        // exposing both heating and cooling setpoints on the same
        // climate entity makes Home Assistant, and through it Google
        // Home, treat the device as a dual-setpoint range thermostat and
        // enforce "lower setpoint <= upper setpoint" - a rule that only
        // makes sense for an actual auto/range mode, not for a device
        // that is always in either heat or cool, never both.
        e
            .numeric("occupied_cooling_setpoint", ea.ALL)
            .withUnit(`${DEG}C`)
            .withValueMin(10)
            .withValueMax(40)
            .withValueStep(0.5)
            .withDescription("Cooling setpoint."),
        e
            .enum("programming_operation_mode", ea.ALL, ["setpoint", "schedule", "eco"])
            .withDescription('Run mode. "setpoint" = manual, "schedule" = follow the weekly program, "eco" = ECO mode.'),
        e
            .enum("thermostat_mode", ea.STATE, ["manual", "schedule", "eco", "regulator", "frost", "holiday", "countdown"])
            .withDescription("Convenience summary of which special mode is currently active (derived from the other attributes, read-only)."),
        e
            .enum("sensor_mode", ea.ALL, ["air", "floor", "air_floor", "external", "external_floor", "floor_percent", "regulator"])
            .withDescription('Which sensor(s) control heating, or "regulator" for plain duty-cycle % control instead of a thermostat.'),
        e
            .numeric("regulator_percentage", ea.ALL)
            .withUnit("%")
            .withValueMin(0)
            .withValueMax(100)
            .withDescription('Output duty cycle when sensor_mode is "regulator".'),
        e.numeric("regulator_cycle", ea.ALL).withUnit("min").withValueMin(0).withValueMax(30).withDescription("Regulator cycle length."),
        e
            .enum("week_program", ea.STATE_GET, ["mon_fri_sat_sun", "mon_sat_sun", "no_time_off", "time_off"])
            .withDescription(
                'Week program split set on the device (read-only): work days / days off. "no_time_off" = every day a work day, "time_off" = every day off. Changes made on the device show up at the next poll.',
            ),
        e.binary("frost", ea.ALL, "ON", "OFF").withDescription('Frost protection. Only usable while system_mode is "heat".'),
        e.binary("window_open_check", ea.ALL, "ON", "OFF").withDescription("Open-window detection (auto pause heating)."),
        e.enum("window_state", ea.STATE, ["open", "closed"]).withDescription("Open-window detection result."),
        e.binary("keypad_lockout", ea.ALL, "LOCK", "UNLOCK").withDescription("Physical button lock on the device."),
        e.enum("temperature_display_mode", ea.ALL, ["celsius", "fahrenheit"]).withDescription("Unit shown on the device's own screen."),
        e.numeric("panel_brightness", ea.ALL).withUnit("%").withValueMin(1).withValueMax(100).withDescription("LCD backlight brightness."),
        e.enum("screen_on_time", ea.ALL, ["always_on", "10s", "30s", "60s"]).withDescription("How long the backlight stays on after a touch."),
        e
            .numeric("countdown_set", ea.ALL)
            .withUnit("min")
            .withValueMin(0)
            .withValueMax(120)
            .withValueStep(5)
            .withDescription("Countdown timer; heating stops when it reaches 0. 0 = cancelled. Not usable in cooling mode."),
        e.binary("vacation_mode", ea.ALL, "ON", "OFF").withDescription("Holds holiday_temp_set until vacation_end."),
        e.text("vacation_start", ea.ALL).withDescription("Vacation start date, format YYYY-MM-DD."),
        e.text("vacation_end", ea.ALL).withDescription("Vacation end date, format YYYY-MM-DD."),
        e
            .numeric("holiday_temp_set", ea.ALL)
            .withUnit(`${DEG}C`)
            .withValueMin(5)
            .withValueMax(40)
            .withDescription("Target temperature while on vacation."),
        e
            .numeric("holiday_temp_set_f", ea.ALL)
            .withUnit(`${DEG}F`)
            .withValueMin(41)
            .withValueMax(104)
            .withDescription(`Target temperature while on vacation (${DEG}F).`),
        e
            .numeric("max_heat_temp", ea.ALL)
            .withUnit(`${DEG}C`)
            .withValueMin(15)
            .withValueMax(35)
            .withDescription("Upper limit for the heating setpoint."),
        e
            .numeric("max_heat_temp_f", ea.ALL)
            .withUnit(`${DEG}F`)
            .withValueMin(59)
            .withValueMax(95)
            .withDescription(`Upper limit for the heating setpoint (${DEG}F).`),
        e
            .numeric("min_cool_temp", ea.ALL)
            .withUnit(`${DEG}C`)
            .withValueMin(10)
            .withValueMax(30)
            .withDescription("Lower limit for the cooling setpoint."),
        e
            .numeric("min_cool_temp_f", ea.ALL)
            .withUnit(`${DEG}F`)
            .withValueMin(50)
            .withValueMax(86)
            .withDescription(`Lower limit for the cooling setpoint (${DEG}F).`),
        e.binary("auto_time", ea.ALL, "ON", "OFF").withDescription("Let the device auto-sync its clock from the coordinator."),
        e.enum("sync_time", ea.SET, ["sync"]).withDescription('Write "sync" to push the current time to the device now.'),
        e.text("clock_last_synced", ea.STATE).withDescription("Device's own clock, as last reported (local time)."),
        e.text("fault", ea.STATE).withDescription('Active fault codes reported by the device, or "none".'),
        e.text("firmware_version", ea.STATE).withDescription("Reported software build ID."),
        e.text("firmware_date", ea.STATE).withDescription("Reported firmware date code."),
        e.numeric("min_heat_setpoint_limit", ea.STATE_GET).withUnit(`${DEG}C`),
        e.numeric("max_heat_setpoint_limit", ea.STATE_GET).withUnit(`${DEG}C`),
        e.numeric("min_cool_setpoint_limit", ea.STATE_GET).withUnit(`${DEG}C`),
        e.numeric("max_cool_setpoint_limit", ea.STATE_GET).withUnit(`${DEG}C`),
        e.numeric("min_heat_setpoint_limit_f", ea.STATE_GET).withUnit(`${DEG}F`),
        e.numeric("max_heat_setpoint_limit_f", ea.STATE_GET).withUnit(`${DEG}F`),
        e.numeric("min_cool_setpoint_limit_f", ea.STATE_GET).withUnit(`${DEG}F`),
        e.numeric("max_cool_setpoint_limit_f", ea.STATE_GET).withUnit(`${DEG}F`),
        e
            .numeric("occupied_heating_setpoint_f", ea.STATE_GET)
            .withUnit(`${DEG}F`)
            .withDescription("Device's own Fahrenheit-mode heating setpoint mirror."),
        e
            .numeric("occupied_cooling_setpoint_f", ea.STATE_GET)
            .withUnit(`${DEG}F`)
            .withDescription("Device's own Fahrenheit-mode cooling setpoint mirror."),
        e.numeric("local_temperature_f", ea.STATE_GET).withUnit(`${DEG}F`).withDescription("Device's own Fahrenheit-mode temperature mirror."),
    ],
};

module.exports = [definition];

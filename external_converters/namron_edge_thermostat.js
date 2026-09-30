// Namron Zigbee Edge Thermostat - external converter (v3.39-test)
// Models: 4566702 / 4566703 / 4512783 / 4512784 (zigbeeModel T11_ZG)
//
// v3.39-test: results from v3.38-test showed 0x8006 stays 0 when the panel's
// control method ("Intelligence" on/off) is switched, so 0x8006 is NOT the
// control method. Adds "scan": reads hvacThermostat 0x0000-0x004f and
// 0x8000-0x8040 (plus hvacUserInterfaceCfg) and publishes which attributes
// changed since the previous scan (scan_changes). All test logging now goes
// to the Z2M log file (logger) instead of console.log.
//
// HOW TO FIND THE CONTROL METHOD ATTRIBUTE:
//   1. Press "scan" (first scan only stores a baseline).
//   2. Switch "Intelligence" on the panel (off -> on or on -> off). Change nothing else.
//   3. Press "scan" again. scan_changes lists every attribute that changed.
//   4. Switch it back and scan again - the same attribute should flip back.
//   Temperature/clock attributes can change on their own; the control method is the
//   one that follows the panel switch both ways.
//
// v3.38-test: built on v3.37-debug. Purpose: settle the open questions before
// porting to src/devices/namron.ts:
//   A) hysteresis (0x8003): is it only used when control_method = hysteresis?
//      Is the scale raw/2?
//   B) 0x8006: control_method (pid/hysteresis) or fault bitmap?
//   C) 0x8026-0x8028: Fahrenheit mirrors of the limits, or PID parameters?
//   D) clock (0x800b): Unix time in local time (already confirmed, kept).
//
// Changes from v3.37-debug:
// - screen_on_time lookup corrected to 0=always_on, 1=10s, 2=30s, 3=60s
//   (confirmed against real hardware, matches the repo and Namron's Homey driver).
// - REMOVED command_probe and its probe command registrations (risk of hitting
//   an unknown command such as a reset). setProgram/setEco kept unchanged.
// - REMOVED pid_kp/ki/kd guesses. 0x8026/0x8027/0x8028 are now exposed as raw
//   read-only values (raw_8026/raw_8027/raw_8028) and logged with both
//   interpretations, see test C.
// - ADDED hysteresis_raw and control_method_raw (read-only) so the scale and
//   the real value of 0x8006 can be seen directly.
// - ADDED hysteresis write read-back (logs what the device actually stored).
// - ADDED "test_snapshot" trigger: reads every attribute involved in the tests
//   and logs them in one block, prefixed [namron_edge_test].
// - ADDED reporting for runningState and pIHeatingDemand so relay behaviour
//   during the hysteresis test is visible without polling.
// - Binds clusters one at a time (genOta binding is not supported by this
//   firmware, and one failing bind must not stop the rest).
//
// HOW TO TEST (log level debug, grep for "[namron_edge_test]"):
//
// A) Hysteresis
//   1. Press test_snapshot. Note control_method / control_method_raw and hysteresis_raw.
//   2. On the physical panel, change the control method from "Intelligence" to hysteresis.
//      Press test_snapshot again. control_method_raw should change (expected 0 -> 1).
//   3. Set hysteresis = 3 from Z2M. The log shows the read-back raw value (expected 6).
//      Check that the panel menu shows 3.0.
//   4. Change hysteresis on the panel to 2.0, press test_snapshot: hysteresis_raw should be 4.
//   5. Set the setpoint 1-2 deg C above room temperature and watch running_state and
//      local_temperature over time. With 3 deg C hysteresis the relay should stay on/off
//      noticeably longer than with 0.5.
//   6. Switch the panel back to "Intelligence" (PID) and repeat step 5 to compare.
//
// B) 0x8006 - answered by step A2. If the raw value follows the panel's control
//    method it is control_method; if it only changes on sensor errors it is a fault bitmap.
//
// C) 0x8026-0x8028
//   1. Press test_snapshot and note raw_8025..raw_8028.
//   2. Change max_heat_temp from Z2M (e.g. 30 -> 28), press test_snapshot again.
//      If raw_8026 changes to the Fahrenheit equivalent x10 (28 deg C = 82.4 deg F -> 824),
//      it is max_heat_temp_f. If it does not move at all, it is not a deg F mirror.
//   3. The log also prints each raw value interpreted as deg F/10 and as /1000 (PID).
//
// D) Clock - press sync_time and check that clock_last_synced and the panel show local time.

const fz = require("zigbee-herdsman-converters/converters/fromZigbee");
const tz = require("zigbee-herdsman-converters/converters/toZigbee");
const exposes = require("zigbee-herdsman-converters/lib/exposes");
const m = require("zigbee-herdsman-converters/lib/modernExtend");
const reporting = require("zigbee-herdsman-converters/lib/reporting");
const {logger} = require("zigbee-herdsman-converters/lib/logger");

const e = exposes.presets;
const ea = exposes.access;

// Standard ZCL DataType codes.
const DataType = {
    BOOLEAN: 0x10,
    BITMAP8: 0x18,
    INT8: 0x28,
    UINT8: 0x20,
    UINT16: 0x21,
    UINT32: 0x23,
    INT16: 0x29,
    ENUM8: 0x30,
    ENUM16: 0x31,
};

// Last scan per device, for scan_changes.
const scanStore = new Map();

const TEST = "[namron_edge_test]";
const DEBUG = "[namron_edge_debug]";

// Goes to the Z2M log file (console.log only reaches stdout).
function log(msg) {
    logger.info(msg, "zhc:namron_edge_test");
}

function errMsg(err) {
    return err?.message ? err.message : String(err);
}

function hex(id) {
    return `0x${id.toString(16).padStart(4, "0")}`;
}

// Raw value of a BITMAP8 can arrive as a number or as an object with getBits().
function rawNumber(value) {
    if (typeof value === "number") return value;
    if (value && typeof value.getBits === "function") {
        return value.getBits().reduce((acc, bit, i) => acc | ((bit ? 1 : 0) << i), 0);
    }
    return Number(value);
}

// --- Namron Zigbee Edge Thermostat -----------------------------------------

// Commands-only custom cluster registration (setProgram 0x07, setEco 0x08).
// Deliberately registers NO attributes - a full attribute registration on this
// cluster breaks Z2M's cluster-name dispatch on this device.
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

// Clock (0x800b): Unix time (seconds since 1970) in *local* time. Confirmed on a 4512783.
function edgeLocalTime() {
    const now = new Date();
    return Math.round(now.getTime() / 1000 - now.getTimezoneOffset() * 60);
}

function smartDateDecode(value) {
    if (!value) return null;
    try {
        if (value > 100000) {
            const s = String(value).padStart(6, "0");
            return `20${s.slice(0, 2)}-${s.slice(2, 4)}-${s.slice(4, 6)}`;
        }
        return new Date(946684800000 + value * 86400000).toISOString().slice(0, 10);
    } catch (_) {
        return null;
    }
}

function dateToYymmdd(value) {
    const match = String(value).match(/^20(\d{2})-(\d{2})-(\d{2})$/);
    if (!match) throw new Error(`Invalid date: ${value}. Use YYYY-MM-DD format, e.g. 2026-06-05.`);
    return Number(match[1] + match[2] + match[3]);
}

function deriveEdgeThermostatMode(frost, vacationMode, sensorMode, progOpMode, boostTimeSet) {
    if (frost === "ON") return "frost";
    if (vacationMode === "ON") return "holiday";
    if (sensorMode === "percent") return "regulator";
    if (boostTimeSet > 0) return "boost";
    if (progOpMode === "schedule") return "schedule";
    if (progOpMode === "eco") return "eco";
    return "manual";
}

const edgeSensorModeLookup = {0: "air", 1: "floor", 2: "both", 3: "air2", 4: "both2", 5: "floor_percent", 6: "percent"};
const edgeSensorModeValueLookup = {air: 0, floor: 1, both: 2, air2: 3, both2: 4, floor_percent: 5, percent: 6};

async function safeReadEdge(endpoint, cluster, attrs) {
    try {
        await endpoint.read(cluster, attrs);
    } catch (_) {}
}

async function writeEdgeHvac(entity, attr, value, type) {
    await entity.write("hvacThermostat", {[attr]: {value, type}});
}

async function writeEdgeHvacDebug(entity, attr, value, type, label) {
    const idHex = typeof attr === "number" ? hex(attr) : String(attr);
    try {
        await entity.write("hvacThermostat", {[attr]: {value, type}});
        log(`${DEBUG} WRITE ${label ?? idHex} (${idHex}) = ${value} (type ${type}) -> OK`);
    } catch (err) {
        log(`${DEBUG} WRITE ${label ?? idHex} (${idHex}) = ${value} (type ${type}) -> FAILED: ${errMsg(err)}`);
        throw err;
    }
}

async function resetProgramingOperModeDebug(entity, meta) {
    try {
        await entity.read("hvacThermostat", ["programingOperMode"]);
        log(`${DEBUG} READ-BEFORE programming_operation_mode(reset) -> OK`);
    } catch (err) {
        log(`${DEBUG} READ-BEFORE programming_operation_mode(reset) -> FAILED (continuing anyway): ${errMsg(err)}`);
    }
    try {
        await tz.thermostat_programming_operation_mode.convertSet(entity, "programming_operation_mode", "setpoint", meta);
        log(`${DEBUG} WRITE programming_operation_mode(reset) = setpoint -> OK`);
    } catch (err) {
        log(`${DEBUG} WRITE programming_operation_mode(reset) -> FAILED: ${errMsg(err)}`);
        throw err;
    }
}

async function debugReadbackThermostatMode(entity) {
    try {
        await entity.read("hvacThermostat", [0x8001, 0x8004, 0x801f, 0x8023, "programingOperMode", "systemMode"]);
    } catch (err) {
        log(`${DEBUG} READBACK failed: ${errMsg(err)}`);
    }
}

async function readThenWriteEdgeHvacDebug(entity, attr, value, type, label) {
    const idHex = typeof attr === "number" ? hex(attr) : String(attr);
    try {
        await entity.read("hvacThermostat", [attr]);
        log(`${DEBUG} READ-BEFORE ${label ?? idHex} (${idHex}) -> OK`);
    } catch (err) {
        log(`${DEBUG} READ-BEFORE ${label ?? idHex} (${idHex}) -> FAILED (continuing anyway): ${errMsg(err)}`);
    }
    await writeEdgeHvacDebug(entity, attr, value, type, label);
}

// Read-before-write: some attributes on this device family return NOT_AUTHORIZED
// unless read immediately before the write. Confirmed needed for the clock (0x800b).
async function readThenWriteEdgeHvac(entity, attr, value, type) {
    await entity.read("hvacThermostat", [attr]).catch(() => {});
    await writeEdgeHvac(entity, attr, value, type);
}

// Attributes the test snapshot reads, with a label for the log.
const testAttrs = {
    32771: "hysteresis",
    32774: "control_method/fault",
    32805: "max_heat_temp (\u00b0C x10)",
    32806: "unknown: max_heat_temp_f or pid_kp",
    32807: "unknown: min_cool_temp or pid_ki",
    32808: "unknown: min_cool_temp_f or pid_kd",
    32779: "clock",
};

const fzEdge = {
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

    namron_private: {
        cluster: "hvacThermostat",
        type: ["attributeReport", "readResponse"],
        convert: (model, msg, publish, options, meta) => {
            const result = {};
            for (const [key, value] of Object.entries(msg.data)) {
                const id = Number(key);
                if (testAttrs[id] !== undefined) {
                    log(`${TEST} ${msg.type} ${hex(id)} ${testAttrs[id]} raw=${JSON.stringify(rawNumber(value))}`);
                }
                switch (id) {
                    case 0x8002:
                        result["window_state"] = value ? "open" : "closed";
                        break;
                    case 0x8004:
                        result["sensor_mode"] = edgeSensorModeLookup[String(value)] ?? String(value);
                        break;
                    case 0x8020:
                        result["vacation_start"] = smartDateDecode(value);
                        break;
                    case 0x8021:
                        result["vacation_end"] = smartDateDecode(value);
                        break;
                    case 0x800a:
                        result["auto_time_sync_pending"] = value === 1 ? "ON" : "OFF";
                        if (value === 1) {
                            writeEdgeHvac(msg.endpoint, 0x800b, edgeLocalTime(), DataType.UINT32)
                                .then(() => writeEdgeHvac(msg.endpoint, 0x800a, 0, DataType.BOOLEAN))
                                .then(() => msg.endpoint.read("hvacThermostat", [0x800b]))
                                .catch(() => {});
                        }
                        break;
                    case 0x800b:
                        try {
                            // local wall-clock time stored as Unix seconds, so format it without a time zone
                            result["clock_last_synced"] = new Date(value * 1000).toISOString().replace("T", " ").slice(0, 19);
                        } catch (_) {
                            result["clock_last_synced"] = String(value);
                        }
                        break;
                    case 0x8024:
                        result["boost_time_remaining"] = value;
                        break;
                    case 0x8003:
                        result["hysteresis_raw"] = rawNumber(value);
                        result["hysteresis"] = rawNumber(value) / 2;
                        break;
                    case 0x8006: {
                        const raw = rawNumber(value);
                        result["control_method_raw"] = raw;
                        result["control_method"] = raw === 1 ? "hysteresis" : raw === 0 ? "pid" : `unknown_${raw}`;
                        break;
                    }
                    case 0x8026:
                    case 0x8027:
                    case 0x8028: {
                        const raw = rawNumber(value);
                        result[`raw_${id.toString(16)}`] = raw;
                        const asF = raw / 10;
                        const asC = Math.round((((asF - 32) * 5) / 9) * 10) / 10;
                        log(`${TEST} ${hex(id)} raw=${raw} -> as \u00b0F/10: ${asF} \u00b0F (= ${asC} \u00b0C) | as PID /1000: ${raw / 1000}`);
                        break;
                    }
                }
            }
            const merged = Object.assign({}, meta?.state ?? {}, result);
            result["thermostat_mode"] = deriveEdgeThermostatMode(
                merged["frost"],
                merged["vacation_mode"],
                merged["sensor_mode"],
                merged["programming_operation_mode"],
                merged["boost_time_set"] ?? 0,
            );
            return result;
        },
    },

    // Logs the standard attributes that matter for the hysteresis test. Returns nothing;
    // fz.thermostat still does the actual parsing.
    test_logger: {
        cluster: "hvacThermostat",
        type: ["attributeReport", "readResponse"],
        convert: (model, msg) => {
            const d = msg.data;
            const parts = [];
            if (d.localTemp !== undefined) parts.push(`local_temperature=${d.localTemp / 100}`);
            if (d.occupiedHeatingSetpoint !== undefined) parts.push(`setpoint=${d.occupiedHeatingSetpoint / 100}`);
            if (d.runningState !== undefined) parts.push(`running_state_raw=${d.runningState}`);
            if (d.pIHeatingDemand !== undefined) parts.push(`pi_heating_demand=${d.pIHeatingDemand}`);
            if (parts.length) log(`${TEST} ${msg.type} ${parts.join(" ")}`);
        },
    },
};

const tzEdge = {
    thermostat_mode: {
        key: ["thermostat_mode", "thermostat_mode_extra"],
        convertSet: async (entity, key, value, meta) => {
            const state = {};
            const wasRegulator = meta.state?.["sensor_mode"] === "percent";
            log(`${DEBUG} SET thermostat_mode = "${value}" (was regulator: ${wasRegulator})`);
            switch (value) {
                case "manual":
                case "schedule":
                case "eco":
                    await readThenWriteEdgeHvacDebug(entity, 0x8001, 0, DataType.BOOLEAN, "frost");
                    await readThenWriteEdgeHvacDebug(entity, 0x801f, 0, DataType.BOOLEAN, "vacation_mode");
                    try {
                        await entity.read("hvacThermostat", ["programingOperMode"]);
                        log(`${DEBUG} READ-BEFORE programming_operation_mode -> OK`);
                    } catch (err) {
                        log(`${DEBUG} READ-BEFORE programming_operation_mode -> FAILED (continuing anyway): ${errMsg(err)}`);
                    }
                    try {
                        if (value === "eco") {
                            await entity.command("hvacThermostat", "setEco", {ecoMode: true}, {disableDefaultResponse: false});
                            log(`${DEBUG} COMMAND setEco(ecoMode:true) -> OK`);
                        } else {
                            await entity.command("hvacThermostat", "setEco", {ecoMode: false}, {disableDefaultResponse: false});
                            log(`${DEBUG} COMMAND setEco(ecoMode:false) -> OK`);
                            await entity.command("hvacThermostat", "setProgram", {runMode: value === "schedule"}, {disableDefaultResponse: false});
                            log(`${DEBUG} COMMAND setProgram(runMode:${value === "schedule"}) -> OK`);
                        }
                    } catch (err) {
                        log(`${DEBUG} COMMAND setProgram/setEco -> FAILED: ${errMsg(err)}`);
                        throw err;
                    }
                    // systemMode is never written - it reads back as Off(0) on this firmware.
                    if (wasRegulator) {
                        await readThenWriteEdgeHvacDebug(entity, 0x8004, 1, DataType.ENUM8, "sensor_mode");
                        state["sensor_mode"] = "floor";
                    }
                    state["frost"] = "OFF";
                    state["vacation_mode"] = "OFF";
                    state["programming_operation_mode"] = value === "manual" ? "setpoint" : value;
                    state["boost_time_set"] = 0;
                    break;
                case "regulator":
                    await readThenWriteEdgeHvacDebug(entity, 0x8001, 0, DataType.BOOLEAN, "frost");
                    await readThenWriteEdgeHvacDebug(entity, 0x801f, 0, DataType.BOOLEAN, "vacation_mode");
                    await readThenWriteEdgeHvacDebug(entity, 0x8004, 6, DataType.ENUM8, "sensor_mode");
                    await resetProgramingOperModeDebug(entity, meta);
                    state["frost"] = "OFF";
                    state["vacation_mode"] = "OFF";
                    state["sensor_mode"] = "percent";
                    state["programming_operation_mode"] = "setpoint";
                    state["boost_time_set"] = 0;
                    break;
                case "frost":
                    await readThenWriteEdgeHvacDebug(entity, 0x801f, 0, DataType.BOOLEAN, "vacation_mode");
                    await readThenWriteEdgeHvacDebug(entity, 0x8001, 1, DataType.BOOLEAN, "frost");
                    await resetProgramingOperModeDebug(entity, meta);
                    state["vacation_mode"] = "OFF";
                    state["frost"] = "ON";
                    state["programming_operation_mode"] = "setpoint";
                    state["boost_time_set"] = 0;
                    break;
                case "holiday":
                    await readThenWriteEdgeHvacDebug(entity, 0x8001, 0, DataType.BOOLEAN, "frost");
                    await readThenWriteEdgeHvacDebug(entity, 0x801f, 1, DataType.BOOLEAN, "vacation_mode");
                    await resetProgramingOperModeDebug(entity, meta);
                    state["frost"] = "OFF";
                    state["vacation_mode"] = "ON";
                    state["programming_operation_mode"] = "setpoint";
                    state["boost_time_set"] = 0;
                    break;
                case "boost": {
                    await readThenWriteEdgeHvacDebug(entity, 0x8001, 0, DataType.BOOLEAN, "frost");
                    await readThenWriteEdgeHvacDebug(entity, 0x801f, 0, DataType.BOOLEAN, "vacation_mode");
                    const hours = meta.state?.["boost_time_set"] > 0 ? meta.state["boost_time_set"] : 1;
                    await readThenWriteEdgeHvacDebug(entity, 0x8023, hours, DataType.ENUM8, "boost_time_set");
                    await resetProgramingOperModeDebug(entity, meta);
                    state["frost"] = "OFF";
                    state["vacation_mode"] = "OFF";
                    state["programming_operation_mode"] = "setpoint";
                    state["boost_time_set"] = hours;
                    break;
                }
                default:
                    throw new Error(`Invalid thermostat_mode: ${value}`);
            }
            state["thermostat_mode"] = value;
            state["thermostat_mode_extra"] = value;
            log(`${DEBUG} Optimistic state after writes: ${JSON.stringify(state)}`);
            await debugReadbackThermostatMode(entity);
            return {state};
        },
        convertGet: async (entity) => {
            await entity.read("hvacThermostat", [0x8001, 0x8004, 0x801f, 0x8023]);
            await entity.read("hvacThermostat", ["programingOperMode"]);
        },
    },

    sensor_mode: {
        key: ["sensor_mode"],
        convertSet: async (entity, key, value, meta) => {
            const raw = edgeSensorModeValueLookup[value];
            if (raw === undefined) throw new Error(`Invalid sensor_mode: ${value}`);
            await writeEdgeHvac(entity, 0x8004, raw, DataType.ENUM8);
            const state = {sensor_mode: value};
            const merged = Object.assign({}, meta.state ?? {}, state);
            state["thermostat_mode"] = deriveEdgeThermostatMode(
                merged["frost"],
                merged["vacation_mode"],
                merged["sensor_mode"],
                merged["programming_operation_mode"],
                merged["boost_time_set"] ?? 0,
            );
            return {state};
        },
        convertGet: async (entity) => {
            await entity.read("hvacThermostat", [0x8004]);
        },
    },

    // 0x8006 is BITMAP8 and the device answers READ_ONLY to writes - read only.
    control_method: {
        key: ["control_method", "control_method_raw"],
        convertGet: async (entity) => {
            await entity.read("hvacThermostat", [0x8006]);
        },
    },

    hysteresis: {
        key: ["hysteresis", "hysteresis_raw"],
        convertSet: async (entity, key, value) => {
            if (key !== "hysteresis") throw new Error("hysteresis_raw is read-only");
            const num = Number(value);
            if (Number.isNaN(num) || num < 0.5 || num > 10) throw new Error("hysteresis must be 0.5-10");
            const raw = Math.round(num * 2);
            // Real type confirmed on hardware: ENUM8 (UINT8/INT8 give INVALID_DATA_TYPE).
            await writeEdgeHvacDebug(entity, 0x8003, raw, DataType.ENUM8, "hysteresis");
            log(`${TEST} hysteresis set to ${num} \u00b0C (raw ${raw}), reading back...`);
            // Genuine read-back - the value logged by namron_private is what the device stored.
            await new Promise((resolve) => setTimeout(resolve, 1000));
            try {
                await entity.read("hvacThermostat", [0x8003, 0x8006]);
            } catch (err) {
                log(`${TEST} hysteresis read-back FAILED: ${errMsg(err)}`);
            }
            return {state: {hysteresis: num, hysteresis_raw: raw}};
        },
        convertGet: async (entity) => {
            await entity.read("hvacThermostat", [0x8003]);
        },
    },

    raw_unknown: {
        key: ["raw_8026", "raw_8027", "raw_8028"],
        convertGet: async (entity) => {
            await entity.read("hvacThermostat", [0x8026, 0x8027, 0x8028]);
        },
    },

    frost: {
        key: ["frost"],
        convertSet: async (entity, key, value) => {
            if (value === "ON") {
                await writeEdgeHvac(entity, 0x801f, 0, DataType.BOOLEAN);
                await writeEdgeHvac(entity, 0x8001, 1, DataType.BOOLEAN);
            } else {
                await writeEdgeHvac(entity, 0x8001, 0, DataType.BOOLEAN);
            }
            return {state: {frost: value}};
        },
    },

    keypad_lockout: {
        key: ["keypad_lockout"],
        convertSet: async (entity, key, value, meta) => {
            const mapped = value === "lock" ? "lock1" : "unlock";
            await tz.thermostat_keypad_lockout.convertSet(entity, key, mapped, meta);
            return {state: {keypad_lockout: value}};
        },
        convertGet: async (entity, key, meta) => tz.thermostat_keypad_lockout.convertGet(entity, key, meta),
    },

    vacation_start: {
        key: ["vacation_start"],
        convertSet: async (entity, key, value) => {
            await writeEdgeHvac(entity, 0x8020, dateToYymmdd(value), DataType.UINT32);
            return {state: {vacation_start: value}};
        },
        convertGet: async (entity) => {
            await entity.read("hvacThermostat", [0x8020]);
        },
    },

    vacation_end: {
        key: ["vacation_end"],
        convertSet: async (entity, key, value) => {
            await writeEdgeHvac(entity, 0x8021, dateToYymmdd(value), DataType.UINT32);
            return {state: {vacation_end: value}};
        },
        convertGet: async (entity) => {
            await entity.read("hvacThermostat", [0x8021]);
        },
    },

    sync_time: {
        key: ["sync_time"],
        convertSet: async (entity) => {
            const ts = edgeLocalTime();
            log(`${TEST} sync_time writing clock = ${ts} (${new Date(ts * 1000).toISOString().replace("T", " ").slice(0, 19)} local)`);
            await readThenWriteEdgeHvac(entity, 0x800b, ts, DataType.UINT32);
            await readThenWriteEdgeHvac(entity, 0x800a, 0, DataType.BOOLEAN);
            try {
                await entity.read("hvacThermostat", [0x800b]);
            } catch (_) {}
            return {state: {sync_time: "sync"}};
        },
    },

    // Reads everything the tests need, one group at a time so one unsupported
    // attribute never aborts the rest. Values show up as [namron_edge_test] lines.
    // Reads the whole attribute range and reports what changed since the previous scan.
    scan: {
        key: ["scan"],
        convertSet: async (entity, key, value, meta) => {
            const ranges = [
                ["hvacThermostat", 0x0000, 0x004f],
                ["hvacThermostat", 0x8000, 0x8040],
                ["hvacUserInterfaceCfg", 0x0000, 0x0002],
            ];
            const current = {};
            for (const [cluster, from, to] of ranges) {
                const ids = [];
                for (let id = from; id <= to; id++) ids.push(id);
                for (let i = 0; i < ids.length; i += 8) {
                    const chunk = ids.slice(i, i + 8);
                    let data;
                    try {
                        data = await entity.read(cluster, chunk, {disableDefaultResponse: true});
                    } catch (_) {
                        data = {};
                        for (const id of chunk) {
                            try {
                                Object.assign(data, await entity.read(cluster, [id], {disableDefaultResponse: true}));
                            } catch (_) {
                                /* unsupported attribute */
                            }
                        }
                    }
                    for (const [k, v] of Object.entries(data ?? {})) {
                        const name = String(Number(k)) === k ? hex(Number(k)) : k;
                        current[`${cluster}.${name}`] = JSON.stringify(
                            v && typeof v === "object" && typeof v.getBits === "function" ? rawNumber(v) : v,
                        );
                    }
                }
            }
            const ieee = meta.device?.ieeeAddr ?? "device";
            const previous = scanStore.get(ieee);
            scanStore.set(ieee, current);
            log(`${TEST} SCAN ${Object.keys(current).length} attributes: ${JSON.stringify(current)}`);
            let changes;
            if (!previous) {
                changes = "baseline stored - change the panel setting and scan again";
            } else {
                const diff = [];
                for (const k of new Set([...Object.keys(previous), ...Object.keys(current)])) {
                    if (previous[k] !== current[k]) diff.push(`${k}: ${previous[k] ?? "-"} -> ${current[k] ?? "-"}`);
                }
                changes = diff.length ? diff.join(" | ") : "no changes";
            }
            log(`${TEST} SCAN CHANGES: ${changes}`);
            return {state: {scan: "scan", scan_changes: changes, scan_time: new Date().toLocaleTimeString()}};
        },
    },

    test_snapshot: {
        key: ["test_snapshot"],
        convertSet: async (entity) => {
            log(`${TEST} ---- snapshot start ----`);
            const groups = [
                ["localTemp", "occupiedHeatingSetpoint", "runningState", "pIHeatingDemand", "systemMode", "programingOperMode"],
                [0x8003, 0x8006],
                [0x8025, 0x8026, 0x8027, 0x8028],
                [0x8004, 0x800b],
            ];
            for (const group of groups) {
                try {
                    await entity.read("hvacThermostat", group);
                } catch (err) {
                    log(`${TEST} read ${JSON.stringify(group)} FAILED, trying one by one: ${errMsg(err)}`);
                    for (const attr of group) {
                        try {
                            await entity.read("hvacThermostat", [attr]);
                        } catch (err2) {
                            log(`${TEST} read ${typeof attr === "number" ? hex(attr) : attr} FAILED: ${errMsg(err2)}`);
                        }
                    }
                }
            }
            log(`${TEST} ---- snapshot done ----`);
            return {state: {test_snapshot: "snapshot"}};
        },
    },
};

// Simple custom attributes via modernExtend (inline attribute ID, no cluster registration).
const edgeModernFields = [
    m.numeric({
        name: "regulator_percentage",
        cluster: "hvacThermostat",
        attribute: {ID: 0x801d, type: DataType.INT16},
        description: 'Output duty cycle when sensor_mode is "percent" (regulator mode).',
        unit: "%",
        valueMin: 0,
        valueMax: 100,
        valueStep: 5,
        access: "ALL",
    }),
    m.numeric({
        name: "regulator_cycle",
        cluster: "hvacThermostat",
        attribute: {ID: 0x8007, type: DataType.UINT8},
        description: "Regulator cycle length. 0 means the regulator is inactive.",
        unit: "min",
        valueMin: 0,
        valueMax: 30,
        access: "ALL",
    }),
    m.numeric({
        name: "max_heat_temp",
        cluster: "hvacThermostat",
        attribute: {ID: 0x8025, type: DataType.INT16},
        description: "Upper limit for the heating setpoint.",
        unit: "\u00b0C",
        valueMin: 15,
        valueMax: 35,
        valueStep: 0.5,
        scale: 10,
        access: "ALL",
    }),
    m.numeric({
        name: "holiday_temp_set",
        cluster: "hvacThermostat",
        attribute: {ID: 0x8013, type: DataType.INT16},
        description: "Target temperature while on vacation.",
        unit: "\u00b0C",
        valueMin: 5,
        valueMax: 35,
        valueStep: 0.5,
        scale: 100,
        access: "ALL",
    }),
    m.numeric({
        name: "panel_brightness",
        cluster: "hvacThermostat",
        attribute: {ID: 0x8005, type: DataType.UINT8},
        description: "LCD backlight brightness.",
        valueMin: 0,
        valueMax: 100,
        access: "ALL",
    }),
    m.numeric({
        name: "boost_time_set",
        cluster: "hvacThermostat",
        attribute: {ID: 0x8023, type: DataType.ENUM8},
        description: "Set hours for boost heating. Setting a value > 0 activates boost mode immediately. Set to 0 to stop boost.",
        unit: "h",
        valueMin: 0,
        valueMax: 24,
        access: "ALL",
    }),
    m.binary({
        name: "window_open_check",
        cluster: "hvacThermostat",
        attribute: {ID: 0x8000, type: DataType.BOOLEAN},
        description: "Open-window detection (auto pause heating).",
        valueOn: ["ON", 1],
        valueOff: ["OFF", 0],
        access: "ALL",
    }),
    m.binary({
        name: "auto_time",
        cluster: "hvacThermostat",
        attribute: {ID: 0x8022, type: DataType.BOOLEAN},
        description: "Let the device auto-sync its clock from the coordinator.",
        valueOn: ["ON", 1],
        valueOff: ["OFF", 0],
        access: "ALL",
    }),
    m.enumLookup({
        name: "screen_on_time",
        cluster: "hvacThermostat",
        attribute: {ID: 0x8029, type: DataType.ENUM8},
        description: "How long the backlight stays on after a touch.",
        // Confirmed on real hardware: 2 = 30s, 3 = 60s.
        lookup: {always_on: 0, "10s": 1, "30s": 2, "60s": 3},
        access: "ALL",
    }),
];
// --- Namron Zigbee Edge Thermostat END -------------------------------------

const definition = {
    zigbeeModel: ["4566702", "4566703", "4512783", "4512784"],
    model: "4566702",
    vendor: "Namron",
    description: "Zigbee Edge Thermostat (external converter v3.39-test)",
    ota: true,
    extend: [m.humidity(), edgeThermostatCommands(), ...edgeModernFields],

    fromZigbee: [
        fzEdge.basic,
        fz.thermostat,
        fzEdge.namron_private,
        fzEdge.test_logger,
        fz.hvac_user_interface,
        fz.metering,
        fz.electrical_measurement,
    ],

    toZigbee: [
        tz.thermostat_occupied_heating_setpoint,
        tz.thermostat_system_mode,
        tz.thermostat_local_temperature_calibration,
        tz.thermostat_programming_operation_mode,
        tz.thermostat_temperature_display_mode,
        tz.thermostat_running_state,
        tz.thermostat_pi_heating_demand,
        tzEdge.thermostat_mode,
        tzEdge.sensor_mode,
        tzEdge.control_method,
        tzEdge.hysteresis,
        tzEdge.raw_unknown,
        tzEdge.frost,
        tzEdge.keypad_lockout,
        tzEdge.vacation_start,
        tzEdge.vacation_end,
        tzEdge.sync_time,
        tzEdge.test_snapshot,
        tzEdge.scan,
    ],

    configure: async (device, coordinatorEndpoint) => {
        const endpoint = device.getEndpoint(1);

        // Bind one at a time - this firmware doesn't support genOta binding,
        // and one failing bind must not stop the rest.
        for (const cluster of ["genTime", "hvacThermostat", "hvacUserInterfaceCfg", "msRelativeHumidity", "seMetering", "haElectricalMeasurement"]) {
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
        // Relay state and heating demand, needed to see the hysteresis working.
        try {
            await reporting.thermostatRunningState(endpoint);
        } catch (_) {}
        try {
            await reporting.thermostatPIHeatingDemand(endpoint);
        } catch (_) {}

        try {
            await endpoint.configureReporting("haElectricalMeasurement", [
                {attribute: "rmsCurrent", minimumReportInterval: 10, maximumReportInterval: 300, reportableChange: 1},
                {attribute: "activePower", minimumReportInterval: 10, maximumReportInterval: 300, reportableChange: 100},
            ]);
        } catch (_) {}

        await safeReadEdge(endpoint, "genBasic", ["swBuildId", "dateCode"]);
        await safeReadEdge(endpoint, "hvacThermostat", [
            "localTemp",
            "occupiedHeatingSetpoint",
            "systemMode",
            "runningMode",
            "runningState",
            "localTemperatureCalibration",
            "pIHeatingDemand",
            "programingOperMode",
            "tempDisplayMode",
        ]);
        await safeReadEdge(endpoint, "hvacUserInterfaceCfg", ["keypadLockout"]);
        await safeReadEdge(endpoint, "seMetering", ["currentSummDelivered", "divisor", "multiplier"]);
        await safeReadEdge(endpoint, "haElectricalMeasurement", [
            "activePower",
            "rmsCurrent",
            "acPowerMultiplier",
            "acPowerDivisor",
            "acCurrentMultiplier",
            "acCurrentDivisor",
        ]);
        await safeReadEdge(
            endpoint,
            "hvacThermostat",
            [
                0x8000, 0x8001, 0x8002, 0x8003, 0x8004, 0x8005, 0x8006, 0x8007, 0x8013, 0x801d, 0x801f, 0x8020, 0x8021, 0x800a, 0x800b, 0x8022,
                0x8023, 0x8024, 0x8025, 0x8026, 0x8027, 0x8028, 0x8029,
            ],
        );

        // Sync time at configure
        await readThenWriteEdgeHvac(endpoint, 0x800b, edgeLocalTime(), DataType.UINT32);
        await readThenWriteEdgeHvac(endpoint, 0x800a, 0, DataType.BOOLEAN);

        // Defaults on every configure: screen_on_time = always_on, temperature_display_mode = celsius.
        await endpoint.write("hvacThermostat", {32809: {value: 0, type: DataType.ENUM8}});
        await endpoint.write("hvacUserInterfaceCfg", {0: {value: 0, type: DataType.ENUM8}});

        device.powerSource = "Mains (single phase)";
        device.save();
    },

    // Periodic time sync, at most once per hour, so vacation mode always has a correct clock.
    onEvent: async (event) => {
        if (event.type === "stop") return;
        const device = event.data.device;
        if (!device) return;
        const now = Date.now();
        const lastSync = device.meta["lastTimeSync"] ?? 0;
        if (now - lastSync > 60 * 60 * 1000) {
            try {
                const endpoint = device.getEndpoint(1);
                await readThenWriteEdgeHvac(endpoint, 0x800b, edgeLocalTime(), DataType.UINT32);
                await readThenWriteEdgeHvac(endpoint, 0x800a, 0, DataType.BOOLEAN);
                device.meta["lastTimeSync"] = now;
                device.save();
            } catch (_) {
                /* ignore */
            }
        }
    },

    exposes: [
        e
            .climate()
            .withLocalTemperature()
            .withSetpoint("occupied_heating_setpoint", 5, 35, 0.5)
            .withSystemMode(["off", "heat"])
            .withRunningState(["idle", "heat"])
            .withLocalTemperatureCalibration(-5, 5, 0.5)
            .withPiHeatingDemand(),
        e.enum("thermostat_mode", ea.ALL, ["manual", "schedule", "regulator"]).withLabel("Thermostat mode"),
        e.enum("thermostat_mode_extra", ea.ALL, ["eco", "frost", "holiday"]).withLabel("Special mode"),
        e
            .enum("sensor_mode", ea.ALL, ["air", "floor", "both", "percent"])
            .withLabel("Sensor mode")
            .withDescription('Sensor the thermostat regulates on. "percent" is regulator mode, also set via thermostat_mode.'),
        e
            .enum("control_method", ea.STATE_GET, ["pid", "hysteresis"])
            .withLabel("Control method")
            .withDescription('Regulation algorithm. "pid" is shown on the panel as "Intelligence mode". Read-only - change it on the panel.'),
        e.numeric("control_method_raw", ea.STATE_GET).withLabel("Control method raw (0x8006, test)"),
        e
            .numeric("hysteresis", ea.ALL)
            .withUnit("\u00b0C")
            .withValueMin(0.5)
            .withValueMax(10)
            .withValueStep(0.5)
            .withLabel("Hysteresis")
            .withDescription('Temperature swing before the relay switches. Expected to only apply when control_method is "hysteresis".'),
        e.numeric("hysteresis_raw", ea.STATE_GET).withLabel("Hysteresis raw (0x8003, test)"),
        e.numeric("raw_8026", ea.STATE_GET).withLabel("Raw 0x8026 (test: max_heat_temp_f or pid_kp)"),
        e.numeric("raw_8027", ea.STATE_GET).withLabel("Raw 0x8027 (test: min_cool_temp or pid_ki)"),
        e.numeric("raw_8028", ea.STATE_GET).withLabel("Raw 0x8028 (test: min_cool_temp_f or pid_kd)"),
        e.enum("scan", ea.SET, ["scan"]).withLabel("Scan attributes (find what the panel changes)"),
        e.text("scan_changes", ea.STATE).withLabel("Scan changes").withDescription("Attributes that changed since the previous scan."),
        e.text("scan_time", ea.STATE).withLabel("Last scan"),
        e.enum("test_snapshot", ea.SET, ["snapshot"]).withLabel("Test snapshot (logs all test values)"),
        e.binary("frost", ea.STATE_SET, "ON", "OFF").withLabel("Frost Mode"),
        e.enum("temperature_display_mode", ea.STATE_SET, ["celsius", "fahrenheit"]).withLabel("Temperature unit"),
        e.binary("vacation_mode", ea.STATE, "ON", "OFF").withLabel("Vacation active"),
        e.text("vacation_start", ea.ALL).withLabel("Vacation start (YYYY-MM-DD)"),
        e.text("vacation_end", ea.ALL).withLabel("Vacation end (YYYY-MM-DD)"),
        e.numeric("boost_time_remaining", ea.STATE).withUnit("min").withLabel("Boost time remaining"),
        e.enum("window_state", ea.STATE, ["open", "closed"]).withLabel("Window state"),
        e.binary("keypad_lockout", ea.STATE_SET, "lock", "unlock").withLabel("Child Lock"),
        e.text("clock_last_synced", ea.STATE).withDescription("Local time the device's clock was last set to."),
        e.enum("sync_time", ea.SET, ["sync"]).withLabel("Sync time"),
        e.text("firmware_version", ea.STATE).withLabel("Firmware version"),
        e.text("firmware_date", ea.STATE).withLabel("Firmware date"),
        e.numeric("energy", ea.STATE).withUnit("kWh").withLabel("Energy"),
        e.numeric("current", ea.STATE).withUnit("A").withLabel("Current"),
        e.numeric("power", ea.STATE).withUnit("W").withLabel("Power"),
        // regulator_percentage, regulator_cycle, max_heat_temp, holiday_temp_set, panel_brightness,
        // boost_time_set, window_open_check, auto_time and screen_on_time come from edgeModernFields.
        // Do NOT add them here too - that causes a duplicate-expose error.
    ],
};

module.exports = [definition];

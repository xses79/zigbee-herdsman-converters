// Namron Zigbee Edge Thermostat - external converter
// Models: 4566702 / 4566703 / 4512783 / 4512784 (zigbeeModel T11_ZG)
//
// Built from src/devices/namron.ts on branch claude/trusting-meitner-ga1p5l
// (commit f4cda1a), i.e. exactly what goes into the pull request, for use until
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
// Clock (0x800b): Unix time (seconds since 1970) in *local* time. HZC's own app for the T11_ZG
// writes Unix time; seconds since 2000 are acknowledged but ignored (a 1996 date). With auto time
// sync on, the display shows the value as-is, with no time zone of its own. Confirmed on a 4512783.
function edgeLocalTime() {
    const now = new Date();
    return Math.round(now.getTime() / 1000 - now.getTimezoneOffset() * 60);
}
// Vacation dates (0x8020/0x8021): days since 1970-01-01, the same encoding as Namron's own Homey driver.
function edgeDateDecode(value) {
    if (!value)
        return null;
    return new Date(value * 86400000).toISOString().slice(0, 10);
}
function edgeDateEncode(value) {
    const [year, month, day] = String(value).split("-").map(Number);
    const days = Date.UTC(year, month - 1, day) / 86400000;
    const valid = String(value).length === 10 && Number.isInteger(days) && edgeDateDecode(days) === value;
    if (!valid)
        throw new Error(`Invalid date: ${value}. Use YYYY-MM-DD format, e.g. 2026-06-05.`);
    return days;
}
function deriveEdgeThermostatMode(frost, vacationMode, sensorMode, progOpMode, countdownSet) {
    if (frost === "ON")
        return "frost";
    if (vacationMode === "ON")
        return "holiday";
    if (sensorMode === "regulator")
        return "regulator";
    if (countdownSet > 0)
        return "countdown";
    if (progOpMode === "schedule")
        return "schedule";
    if (progOpMode === "eco")
        return "eco";
    return "manual";
}
const edgeSensorModeLookup = {
    "0": "air",
    "1": "floor",
    "2": "air_floor",
    "3": "external",
    "4": "external_floor",
    "5": "floor_percent",
    "6": "regulator",
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
const edgeOnOffLookup = { OFF: 0, ON: 1 };
// Week program (0x8003), mapped on real hardware by changing it on the device.
// Names follow the device's own labels: "no time off" = every day a work day, "time off" = every day off.
const edgeWeekProgramLookup = { mon_fri_sat_sun: 0, mon_sat_sun: 1, no_time_off: 2, time_off: 3 };
const edgeOnOffReverseLookup = { "0": "OFF", "1": "ON" };
// id 2/3 confirmed against real hardware (Namron's own Homey driver agrees).
const edgeScreenOnTimeLookup = { "0": "always_on", "1": "10s", "2": "30s", "3": "60s" };
const edgeScreenOnTimeValueLookup = { always_on: 0, "10s": 1, "30s": 2, "60s": 3 };
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
            setProgram: { ID: 0x07, name: "setProgram", parameters: [{ name: "runMode", type: DataType.BOOLEAN }] },
            setEco: { ID: 0x08, name: "setEco", parameters: [{ name: "ecoMode", type: DataType.BOOLEAN }] },
        },
        commandsResponse: {},
    });
}
async function safeReadEdge(endpoint, cluster, attrs) {
    try {
        await endpoint.read(cluster, attrs);
    }
    catch (_) { }
}
// The device answers a read of many attributes with only the first 14 or so, so the custom attributes are read in
// small groups. Used by configure and on every Zigbee2MQTT start, so the state is filled in without a reconfigure.
const edgeCustomAttributes = [
    0x8000, 0x8001, 0x8002, 0x8003, 0x8004, 0x8005, 0x8006, 0x8007, 0x800a, 0x800b, 0x8011, 0x8012, 0x8013, 0x801d, 0x801f, 0x8020, 0x8021, 0x8022,
    0x8023, 0x8024, 0x8025, 0x8029,
];
async function edgeReadAll(endpoint) {
    await safeReadEdge(endpoint, "genBasic", ["swBuildId", "dateCode"]);
    await safeReadEdge(endpoint, "hvacThermostat", ["localTemp", "occupiedHeatingSetpoint", "occupiedCoolingSetpoint", "systemMode"]);
    await safeReadEdge(endpoint, "hvacThermostat", ["runningState", "localTemperatureCalibration", "pIHeatingDemand", "programingOperMode"]);
    await safeReadEdge(endpoint, "hvacThermostat", ["absMinHeatSetpointLimit", "absMaxHeatSetpointLimit"]);
    for (let i = 0; i < edgeCustomAttributes.length; i += 8) {
        await safeReadEdge(endpoint, "hvacThermostat", edgeCustomAttributes.slice(i, i + 8));
    }
    await safeReadEdge(endpoint, "hvacUserInterfaceCfg", ["keypadLockout", "tempDisplayMode"]);
    await safeReadEdge(endpoint, "seMetering", ["currentSummDelivered", "divisor", "multiplier"]);
    await safeReadEdge(endpoint, "haElectricalMeasurement", ["activePower", "rmsCurrent", "acPowerMultiplier", "acPowerDivisor"]);
}
function edgeReadOnStartup() {
    const onEvent = (event) => {
        if (event.type === "start") {
            const endpoint = event.data.device.getEndpoint(1);
            if (endpoint) {
                // Not awaited, so startup is not held up; safeReadEdge already ignores read errors.
                void edgeReadAll(endpoint);
            }
        }
    };
    return { onEvent: [onEvent], isModernExtend: true };
}
async function writeEdgeHvac(entity, attr, value, type) {
    // Confirmed via testing: this firmware rejects several of these writes
    // with NOT_AUTHORIZED unless a default response is requested, so unlike
    // most modern converters we do NOT pass disableDefaultResponse: true here.
    await entity.write("hvacThermostat", { [attr]: { value, type } }, { disableDefaultResponse: false });
}
async function readThenWriteEdgeHvac(entity, attr, value, type) {
    // Some attributes (frost, window_open_check, vacation_mode, the time-sync
    // value) were confirmed to need a prior read in the same session before
    // a write is accepted - a known quirk of this HZC-platform firmware.
    try {
        await entity.read("hvacThermostat", [attr]);
    }
    catch (_) { }
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
    }
    catch (_) { }
}
// programingOperMode is a bitmap on this device: bit 0 = schedule, bit 2 = eco. It reports 5 (schedule + eco),
// which fz.thermostat's lookup (0, 1, 3, 4) rejects with an exception that also drops the rest of the message.
function edgeProgrammingOperationMode(value) {
    if (value & 0x04)
        return "eco";
    if (value & 0x01)
        return "schedule";
    return "setpoint";
}
// Week program schedule: the device sends its whole week program on the private cluster 0xE002 (command 0x07,
// server to client) whenever it is changed on the device. 32 bytes = 8 entries of [hour][minute][temperature x10,
// 2 bytes big-endian]: 6 work-day entries followed by 2 day-off entries. Attribute 0x0007 of the same cluster holds
// the program too, but the firmware returns it as a CHAR_STRING whose length byte is the first program byte (the
// wake hour), so reads come back truncated and corrupted. Writing it restarted the Zigbee module, so it is read-only.
const edgeWeekProgramParameters = Array.from({ length: 32 }, (_, i) => ({ name: `p${i}`, type: DataType.UINT8 }));
function edgeWeekProgramCluster() {
    return m.deviceAddCustomCluster("namronEdgeWeekProgram", {
        ID: 0xe002,
        name: "namronEdgeWeekProgram",
        attributes: {},
        commands: {},
        commandsResponse: { weekProgram: { ID: 0x07, name: "weekProgram", parameters: edgeWeekProgramParameters } },
    });
}
// The temperatures follow the display unit: in Fahrenheit mode the device sends them in deg F (x10).
function edgeWeekProgramSchedule(bytes, fahrenheit) {
    const entries = [];
    for (let i = 0; i + 3 < bytes.length; i += 4) {
        const time = `${String(bytes[i]).padStart(2, "0")}:${String(bytes[i + 1]).padStart(2, "0")}`;
        const raw = (((bytes[i + 2] & 0x0f) << 8) | bytes[i + 3]) / 10;
        const temperature = fahrenheit ? Math.round(((raw - 32) * 5) / 9 / 0.5) * 0.5 : raw;
        entries.push(`${time} ${temperature}`);
    }
    return `Work days: ${entries.slice(0, 6).join(", ")} | Days off: ${entries.slice(6).join(", ")}`;
}
function edgeCelsiusToFahrenheit(value) {
    return Math.round(((value * 9) / 5 + 32) * 10) / 10;
}
function edgeFahrenheitToCelsius(value) {
    return Math.round((((value / 100 - 32) * 5) / 9) * 10) / 10;
}
// runningState is a bitmap. While cooling the device reports 258 (0x0102: bit 1 = cool plus a non-standard bit 8),
// which fz.thermostat's lookup rejects with an exception that also drops the rest of the message.
function edgeRunningState(value) {
    if (value & 0x01)
        return "heat";
    if (value & 0x02)
        return "cool";
    return "idle";
}
const fzEdge = {
    week_program_schedule: {
        cluster: "namronEdgeWeekProgram",
        type: ["commandWeekProgram"],
        convert: (model, msg, publish, options, meta) => {
            const bytes = edgeWeekProgramParameters.map((p) => Number(msg.data[p.name] ?? 0));
            const fahrenheit = meta.state.temperature_display_mode === "fahrenheit";
            return { week_program_schedule: edgeWeekProgramSchedule(bytes, fahrenheit) };
        },
    },
    thermostat: {
        cluster: "hvacThermostat",
        type: ["attributeReport", "readResponse"],
        convert: (model, msg, publish, options, meta) => {
            const { programingOperMode, runningState, ...rest } = msg.data;
            const result = Object.keys(rest).length > 0 ? (fz.thermostat.convert(model, { ...msg, data: rest }, publish, options, meta) ?? {}) : {};
            if (programingOperMode !== undefined) {
                result.programming_operation_mode = edgeProgrammingOperationMode(programingOperMode);
            }
            if (runningState !== undefined) {
                result.running_state = edgeRunningState(runningState);
            }
            return result;
        },
    },
    basic: {
        cluster: "genBasic",
        type: ["attributeReport", "readResponse"],
        convert: (model, msg) => {
            const result = {};
            if (msg.data["swBuildId"] !== undefined)
                result["firmware_version"] = msg.data["swBuildId"];
            if (msg.data["dateCode"] !== undefined)
                result["firmware_date"] = msg.data["dateCode"];
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
                    case 0x8004:
                        result["sensor_mode"] = edgeSensorModeLookup[String(value)] ?? String(value);
                        break;
                    case 0x8005:
                        result["panel_brightness"] = value;
                        break;
                    case 0x8006: {
                        // Bitmap, arrives as a plain number. Bit 5 shows "External Sensor Error" on the display
                        // (floor sensor selected but not connected); other bits use the er0-er7 names of Namron's own
                        // Homey driver until their meaning is known.
                        const faults = [];
                        for (let bit = 0; bit < 8; bit++) {
                            if (value & (1 << bit))
                                faults.push(bit === 5 ? "external_sensor_error" : `er${bit}`);
                        }
                        result["fault"] = faults.length ? faults.join(",") : "none";
                        break;
                    }
                    case 0x800a:
                        result["auto_time_sync_pending"] = edgeOnOffReverseLookup[String(value)] ?? String(value);
                        if (value === 1) {
                            writeEdgeHvac(msg.endpoint, 0x800b, edgeLocalTime(), DataType.UINT32)
                                .then(() => writeEdgeHvac(msg.endpoint, 0x800a, 0, DataType.BOOLEAN))
                                .then(() => msg.endpoint.read("hvacThermostat", [0x800a, 0x800b]))
                                .catch(() => { });
                        }
                        break;
                    case 0x800b:
                        try {
                            // local wall-clock time stored as Unix seconds, so format it without a time zone
                            result["clock_last_synced"] = new Date(value * 1000).toISOString().replace("T", " ").slice(0, 19);
                        }
                        catch (_) {
                            result["clock_last_synced"] = String(value);
                        }
                        break;
                    // Fahrenheit setpoint and temperature (deg F x100). While the display is in Fahrenheit the device
                    // reports only these, not occupiedHeatingSetpoint/localTemp, so they are converted to deg C for the
                    // climate entity. In Celsius mode they are stale and ignored. Confirmed on firmware 1.12 and 1.14.
                    case 0x8011:
                        if (meta.state.temperature_display_mode === "fahrenheit") {
                            result["occupied_heating_setpoint"] = edgeFahrenheitToCelsius(value);
                        }
                        break;
                    case 0x8012:
                        if (meta.state.temperature_display_mode === "fahrenheit") {
                            result["local_temperature"] = edgeFahrenheitToCelsius(value);
                        }
                        break;
                    case 0x8013:
                        result["holiday_temp_set"] = value / 100;
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
            result["thermostat_mode"] = deriveEdgeThermostatMode(merged["frost"], merged["vacation_mode"], merged["sensor_mode"], merged["programming_operation_mode"], merged["countdown_set"] ?? 0);
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
                }
                catch (_) {
                    /* non-fatal courtesy side-effect */
                }
            };
            if (value === "eco") {
                await clearVacationMode();
                await entity.command("hvacThermostat", "setEco", { ecoMode: true }, { disableDefaultResponse: false });
            }
            else {
                await entity.command("hvacThermostat", "setEco", { ecoMode: false }, { disableDefaultResponse: false });
                await clearVacationMode();
                await entity.command("hvacThermostat", "setProgram", { runMode: value === "schedule" }, { disableDefaultResponse: false });
            }
            return { state: { programming_operation_mode: value } };
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
            if (raw === undefined)
                throw new Error(`Invalid sensor_mode: ${value}`);
            if (value === "regulator" && meta.state?.["system_mode"] === "cool") {
                throw new Error("Cannot switch to regulator mode while in cooling mode");
            }
            // No optimistic state: the device acknowledges a mode whose sensor is not connected but keeps the
            // previous mode, so sensor_mode comes from the read-back only.
            await writeThenReadEdgeHvac(entity, 0x8004, raw, DataType.ENUM8, [0x8004, 0x801d, 0x8007]);
        },
        convertGet: async (entity) => {
            await entity.read("hvacThermostat", [0x8004]);
        },
    },
    frost: {
        key: ["frost"],
        convertSet: async (entity, key, value) => {
            await readThenWriteEdgeHvac(entity, 0x8001, value === "ON" ? 1 : 0, DataType.BOOLEAN);
            return { state: { frost: value } };
        },
        convertGet: async (entity) => {
            await entity.read("hvacThermostat", [0x8001]);
        },
    },
    window_open_check: {
        key: ["window_open_check"],
        convertSet: async (entity, key, value) => {
            const raw = edgeOnOffLookup[value];
            if (raw === undefined)
                throw new Error(`Invalid window_open_check: ${value}`);
            await readThenWriteEdgeHvac(entity, 0x8000, raw, DataType.BOOLEAN);
            return { state: { window_open_check: value } };
        },
        convertGet: async (entity) => {
            await entity.read("hvacThermostat", [0x8000]);
        },
    },
    vacation_mode: {
        key: ["vacation_mode"],
        convertSet: async (entity, key, value) => {
            const raw = edgeOnOffLookup[value];
            if (raw === undefined)
                throw new Error(`Invalid vacation_mode: ${value}`);
            await readThenWriteEdgeHvac(entity, 0x801f, raw, DataType.BOOLEAN);
            return { state: { vacation_mode: value } };
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
            return { state: { vacation_start: value } };
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
            return { state: { vacation_end: value } };
        },
        convertGet: async (entity) => {
            await entity.read("hvacThermostat", [0x8021]);
        },
    },
    auto_time: {
        key: ["auto_time"],
        convertSet: async (entity, key, value) => {
            const raw = edgeOnOffLookup[value];
            if (raw === undefined)
                throw new Error(`Invalid auto_time: ${value}`);
            await readThenWriteEdgeHvac(entity, 0x8022, raw, DataType.BOOLEAN);
            return { state: { auto_time: value } };
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
            }
            catch (_) { }
            return { state: { sync_time: "sync" } };
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
            return { state: { countdown_set: minutes } };
        },
        convertGet: async (entity) => {
            await entity.read("hvacThermostat", [0x8023]);
        },
    },
    // Week program (0x8003) is read-only: changes made on the device read back, but the device is not
    // confirmed to act on writes, and it does not report changes, so it is polled.
    // Hysteresis is not exposed: it is not reachable over Zigbee (checked on firmware 1.12 and 1.14).
    // Both firmwares answer UNSUPPORTED_ATTRIBUTE for 0x8035, 0x8041, 0x8045 and 0x8052 (1.14 also
    // for 0x802a-0x8040), and changing hysteresis on the device changes no readable attribute.
    // 0x8003 is not hysteresis but the week program setting (week_program above). The "Intelligence"
    // on/off setting is not reachable over Zigbee either. Discover Attributes on hvacThermostat ends at
    // 0x8029, and manufacturer-specific discover (0x126a) returns no attributes on any cluster.
    // Likewise display-only (nothing reported or changed when set on the device): "Equipment" (electric/water)
    // and "Idle backlight".
    screen_on_time: {
        key: ["screen_on_time"],
        convertSet: async (entity, key, value) => {
            const raw = edgeScreenOnTimeValueLookup[value];
            if (raw === undefined)
                throw new Error(`Invalid screen_on_time: ${value}`);
            await writeThenReadEdgeHvac(entity, 0x8029, raw, DataType.ENUM8, [0x8029]);
            return { state: { screen_on_time: value } };
        },
        convertGet: async (entity) => {
            await entity.read("hvacThermostat", [0x8029]);
        },
    },
    panel_brightness: {
        key: ["panel_brightness"],
        convertSet: async (entity, key, value) => {
            const num = Math.round(Number(value));
            if (Number.isNaN(num) || num < 1 || num > 100)
                throw new Error("panel_brightness must be 1-100 (%)");
            await writeThenReadEdgeHvac(entity, 0x8005, num, DataType.UINT8, [0x8005]);
            return { state: { panel_brightness: num } };
        },
        convertGet: async (entity) => {
            await entity.read("hvacThermostat", [0x8005]);
        },
    },
    // In Fahrenheit display mode localTemp is stale and the deg F mirror (0x8012) holds the current temperature.
    local_temperature: {
        key: ["local_temperature"],
        convertGet: async (entity, key, meta) => {
            const fahrenheit = meta.state?.temperature_display_mode === "fahrenheit";
            await entity.read("hvacThermostat", fahrenheit ? [0x8012] : ["localTemp"]);
        },
    },
    holiday_temp_set: {
        key: ["holiday_temp_set"],
        convertSet: async (entity, key, value) => {
            const num = Number(value);
            if (Number.isNaN(num) || num < 5 || num > 40)
                throw new Error("holiday_temp_set must be 5-40");
            // The device keeps a separate deg F value (0x801b) that it uses in Fahrenheit display mode; keep both in step.
            await writeEdgeHvac(entity, 0x8013, Math.round(num * 100), DataType.INT16);
            await writeEdgeHvac(entity, 0x801b, Math.round(edgeCelsiusToFahrenheit(num) * 100), DataType.INT16);
            return { state: { holiday_temp_set: num } };
        },
        convertGet: async (entity) => {
            await entity.read("hvacThermostat", [0x8013]);
        },
    },
    max_heat_temp: {
        key: ["max_heat_temp"],
        convertSet: async (entity, key, value) => {
            const num = Number(value);
            if (Number.isNaN(num) || num < 15 || num > 35)
                throw new Error("max_heat_temp must be 15-35");
            // The device keeps a separate deg F value (0x8026) that it uses in Fahrenheit display mode; keep both in step.
            await writeEdgeHvac(entity, 0x8025, Math.round(num * 10), DataType.INT16);
            await writeEdgeHvac(entity, 0x8026, Math.round(edgeCelsiusToFahrenheit(num) * 10), DataType.INT16);
            return { state: { max_heat_temp: num } };
        },
        convertGet: async (entity) => {
            await entity.read("hvacThermostat", [0x8025]);
        },
    },
};
// --- Namron Zigbee Edge Thermostat END ---------------------------------------

const definition = {
    zigbeeModel: ["4566702", "4566703", "4512783", "4512784"],
    model: "4566702",
    vendor: "Namron",
    description: "Zigbee Edge Thermostat (external converter, repo f4cda1a)",
    ota: true,
    extend: [
        edgeThermostatCommands(),
        edgeWeekProgramCluster(),
        edgeReadOnStartup(),
        m.numeric({
            name: "regulator_percentage",
            cluster: "hvacThermostat",
            attribute: { ID: 0x801d, type: DataType.INT16 },
            unit: "%",
            valueMin: 0,
            valueMax: 100,
            valueStep: 1,
            description: 'Output duty cycle when sensor_mode is "regulator".',
            zigbeeCommandOptions: { disableDefaultResponse: false },
            reporting: false,
        }),
        // Read-only. The regulator cycle (1-30 min) is set on the device. 0x8007 is the Zigbee module's own copy: writes
        // are acknowledged but never reach the display or the regulation (tried a plain write, read-before-write,
        // read-write-read and a write together with sensorMode as Namron's Homey app does; firmware 1.12 and 1.14), and
        // changes made on the device only sometimes update it.
        m.numeric({
            name: "regulator_cycle",
            cluster: "hvacThermostat",
            attribute: { ID: 0x8007, type: DataType.UINT8 },
            unit: "min",
            valueMin: 1,
            valueMax: 30,
            valueStep: 1,
            zigbeeCommandOptions: { disableDefaultResponse: false },
            description: "Regulator cycle length as held by the Zigbee module (read-only). The cycle is set on the device (1-30 min) and this value is not always updated from it, so it can differ from the display.",
            reporting: false,
        }),
        m.enumLookup({
            name: "week_program",
            cluster: "hvacThermostat",
            attribute: { ID: 0x8003, type: DataType.ENUM8 },
            lookup: edgeWeekProgramLookup,
            access: "STATE_GET",
            description: 'Week program split set on the device (read-only): work days / days off. "no_time_off" = every day a work day, "time_off" = every day off. Changes made on the device show up at the next poll.',
            reporting: false,
        }),
        m.enumLookup({
            name: "window_state",
            cluster: "hvacThermostat",
            attribute: { ID: 0x8002, type: DataType.BOOLEAN },
            lookup: { closed: 0, open: 1 },
            access: "STATE",
            description: "Open-window detection result.",
            reporting: false,
        }),
        m.numeric({
            name: "countdown_left",
            cluster: "hvacThermostat",
            attribute: { ID: 0x8024, type: DataType.UINT32 },
            unit: "min",
            access: "STATE_GET",
            // With no countdown running the firmware holds a meaningless value (e.g. 1325465600), shown as 0.
            scale: (value, type) => (type === "from" && value > 120 ? 0 : value),
            description: "Minutes left of a running countdown, as reported by the device.",
            reporting: false,
        }),
        // The device accepts a calibration of -10 to +10 deg C (confirmed on the device), wider than the ZCL default of +/-2.5 deg C.
        // Same as m.customLocalTemperatureCalibrationRange({min: -10, max: 10}) in the repo, inlined so this
        // file also works on Z2M versions that do not have that helper yet.
        m.deviceAddCustomCluster("hvacThermostat", {
            ID: 0x0201,
            name: "hvacThermostat",
            attributes: {
                localTemperatureCalibration: {name: "localTemperatureCalibration", ID: 0x0010, type: DataType.INT8, write: true, min: -100, max: 100, default: 0},
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
                if (!endpoint)
                    return;
                await endpoint.read("hvacThermostat", [0x8003]);
            },
        }),
        m.onOff({ powerOnBehavior: false }),
        m.humidity(),
        m.electricityMeter({ voltage: false, configureReporting: false }),
    ],
    fromZigbee: [fzEdge.basic, fzEdge.thermostat, fzEdge.edge_custom, fz.hvac_user_interface, fzEdge.week_program_schedule],
    toZigbee: [
        tzEdge.system_mode,
        tz.thermostat_occupied_heating_setpoint,
        tz.thermostat_occupied_cooling_setpoint,
        tz.thermostat_running_state,
        tzEdge.local_temperature,
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
        tzEdge.screen_on_time,
        tzEdge.panel_brightness,
        tzEdge.holiday_temp_set,
        tzEdge.max_heat_temp,
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
                setProgram: { ID: 0x07, name: "setProgram", parameters: [{ name: "runMode", type: DataType.BOOLEAN }] },
                setEco: { ID: 0x08, name: "setEco", parameters: [{ name: "ecoMode", type: DataType.BOOLEAN }] },
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
            }
            catch (_) { }
        }
        try {
            await reporting.thermostatTemperature(endpoint, { min: 10, max: 300, change: 10 });
        }
        catch (_) { }
        try {
            await reporting.thermostatOccupiedHeatingSetpoint(endpoint, { min: 10, max: 300, change: 50 });
        }
        catch (_) { }
        try {
            await reporting.thermostatOccupiedCoolingSetpoint(endpoint, { min: 10, max: 300, change: 50 });
        }
        catch (_) { }
        try {
            await reporting.humidity(endpoint, { min: 10, max: 300, change: 100 });
        }
        catch (_) { }
        await edgeReadAll(endpoint);
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
            .withDescription("Cooling setpoint. The device has one setpoint on its display: writing this while heating also changes occupied_heating_setpoint. Cooling (system_mode cool) is only accepted with Equipment set to Water on the device; with Electric the device returns to heat."),
        e
            .enum("programming_operation_mode", ea.ALL, ["setpoint", "schedule", "eco"])
            .withDescription('Run mode. "setpoint" = manual, "schedule" = follow the weekly program, "eco" = ECO mode.'),
        e
            .enum("thermostat_mode", ea.STATE, ["manual", "schedule", "eco", "regulator", "frost", "holiday", "countdown"])
            .withDescription("Convenience summary of which special mode is currently active (derived from the other attributes, read-only)."),
        e
            .enum("sensor_mode", ea.ALL, ["air", "floor", "air_floor", "external", "external_floor", "floor_percent", "regulator"])
            .withDescription('Which sensor(s) control heating, or "regulator" for plain duty-cycle % control instead of a thermostat. A mode chosen on the device whose sensor is not connected is shown on the device but not reported, so this can then differ from the device.'),
        e
            .text("week_program_schedule", ea.STATE)
            .withDescription("Week program times and temperatures (read-only), sent by the device when the program is changed on the device. Shows nothing until the program is changed."),
        e.binary("frost", ea.ALL, "ON", "OFF").withDescription('Frost protection. Only usable while system_mode is "heat".'),
        e.binary("window_open_check", ea.ALL, "ON", "OFF").withDescription("Open-window detection (auto pause heating)."),
        e.binary("keypad_lockout", ea.ALL, "lock1", "unlock").withDescription("Physical button lock on the device."),
        e.enum("temperature_display_mode", ea.ALL, ["celsius", "fahrenheit"]).withDescription("Unit shown on the device's own screen."),
        e
            .numeric("panel_brightness", ea.ALL)
            .withUnit("%")
            .withValueMin(1)
            .withValueMax(100)
            .withDescription('Display brightness while in use ("Active backlight" on the device).'),
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
            .numeric("max_heat_temp", ea.ALL)
            .withUnit(`${DEG}C`)
            .withValueMin(15)
            .withValueMax(35)
            .withDescription("Upper limit for the heating setpoint."),
        e.binary("auto_time", ea.ALL, "ON", "OFF").withDescription("Let the device auto-sync its clock from the coordinator."),
        e.enum("sync_time", ea.SET, ["sync"]).withDescription('Write "sync" to push the current time to the device now.'),
        e.text("clock_last_synced", ea.STATE).withDescription("Local time the device's clock was last set to."),
        e
            .text("fault", ea.STATE)
            .withDescription('Active faults reported by the device, or "none". "external_sensor_error" = floor/external sensor missing or faulty.'),
        e.text("firmware_version", ea.STATE).withDescription("Reported software build ID."),
        e.text("firmware_date", ea.STATE).withDescription("Reported firmware date code."),
        // The device has the absolute limits (0x0003/0x0004) but not minHeatSetpointLimit/maxHeatSetpointLimit (0x0015/0x0016).
        e.numeric("abs_min_heat_setpoint_limit", ea.STATE).withUnit(`${DEG}C`).withDescription("Lowest heating setpoint the device allows."),
        e.numeric("abs_max_heat_setpoint_limit", ea.STATE).withUnit(`${DEG}C`).withDescription("Highest heating setpoint the device allows."),
    ],
};

module.exports = [definition];
